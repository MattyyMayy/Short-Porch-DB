// Fetches Manchester United data and writes it to data/ as JSON for
// Stretford.html to read. Runs in GitHub Actions so the API key stays secret.
//
// Two sources, because API-Football's free plan only covers older seasons:
//  - openfootball (free, no key): table, results and fixtures, no player stats.
//  - API-Football (key in API_FOOTBALL_KEY): table, results and player stats.
//
// Usage: API_FOOTBALL_KEY=... node scripts/fetch-data.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const API = process.env.API_FOOTBALL_URL || "https://v3.football.api-sports.io";
const OPENFOOTBALL = process.env.OPENFOOTBALL_URL || "https://raw.githubusercontent.com/openfootball/football.json/master";
const KEY = process.env.API_FOOTBALL_KEY;
const LEAGUE = 39; // Premier League
const TEAM = 33;   // Manchester United
const OPENFOOTBALL_TEAM = "Manchester United FC";
const OUT = new URL("../data/", import.meta.url);

// Seasons are named by their starting year: 2026 = 2026/27. The first entry
// is the current season and is refreshed on every run; the others are only
// fetched once, when their file is missing.
const SEASONS = [
  { season: 2026, source: "openfootball" },
  { season: 2025, source: "openfootball" },
  { season: 2024, source: "api-football" },
  { season: 2023, source: "api-football" },
  { season: 2022, source: "api-football" }
];

// Free plan limits: 10 requests a minute, and at most 3 pages of players.
const DELAY_MS = 7000;
const MAX_PLAYER_PAGES = 3;
const FINISHED = new Set(["FT", "AET", "PEN"]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const resultOf = (f, a) => (f > a ? "W" : f < a ? "L" : "D");
let calls = 0;

// ---- API-Football ----

async function api(path) {
  if (calls++) await sleep(DELAY_MS);
  const res = await fetch(`${API}/${path}`, { headers: { "x-apisports-key": KEY } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const body = await res.json();
  // Errors come back with HTTP 200 and an "errors" object or array.
  const errors = Array.isArray(body.errors) ? body.errors : Object.values(body.errors || {});
  if (errors.length) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

async function apiStandings(season) {
  const body = await api(`standings?league=${LEAGUE}&season=${season}`);
  const table = body.response[0]?.league?.standings?.[0] || [];
  return table.map(r => ({
    rank: r.rank,
    team: r.team.name,
    us: r.team.id === TEAM,
    p: r.all.played, w: r.all.win, d: r.all.draw, l: r.all.lose,
    gf: r.all.goals.for, ga: r.all.goals.against,
    gd: r.goalsDiff, pts: r.points,
    form: (r.form || "").split("").filter(c => "WDL".includes(c))
  }));
}

async function apiFixtures(season) {
  const body = await api(`fixtures?league=${LEAGUE}&season=${season}&team=${TEAM}`);
  return body.response
    .map(f => {
      const home = f.teams.home.id === TEAM;
      const done = FINISHED.has(f.fixture.status.short);
      const gf = done ? (home ? f.goals.home : f.goals.away) : null;
      const ga = done ? (home ? f.goals.away : f.goals.home) : null;
      return {
        kickoff: f.fixture.date,
        status: f.fixture.status.short,
        home,
        opponent: home ? f.teams.away.name : f.teams.home.name,
        gf, ga,
        result: done ? resultOf(gf, ga) : null
      };
    })
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}

async function apiPlayers(season) {
  const out = [];
  let total = 1;
  for (let page = 1; page <= Math.min(total, MAX_PLAYER_PAGES); page++) {
    const body = await api(`players?team=${TEAM}&season=${season}&league=${LEAGUE}&page=${page}`);
    total = body.paging?.total || 1;
    for (const { player, statistics } of body.response) {
      const s = statistics.find(x => x.league?.id === LEAGUE && x.team?.id === TEAM);
      const apps = s?.games?.appearences || 0; // sic: the API spells it this way
      if (!apps) continue;
      out.push({
        name: player.name,
        pos: s.games.position,
        apps,
        minutes: s.games.minutes || 0,
        goals: s.goals.total || 0,
        assists: s.goals.assists || 0,
        rating: s.games.rating ? Number(s.games.rating) : null
      });
    }
  }
  return { players: out, partial: total > MAX_PLAYER_PAGES };
}

async function fromApiFootball(season) {
  if (!KEY) throw new Error("API_FOOTBALL_KEY is not set");
  const standings = await apiStandings(season);
  const fixtures = await apiFixtures(season);
  const { players, partial } = await apiPlayers(season);

  // The docs don't say which end of "form" is the latest match, so check it
  // against our own results and flip every row to oldest-first if needed.
  const ours = standings.find(r => r.us);
  const last = fixtures.filter(f => f.result).slice(-ours?.form.length || 0).map(f => f.result).join("");
  if (ours && ours.form.join("") !== last && [...ours.form].reverse().join("") === last) {
    standings.forEach(r => r.form.reverse());
  }

  return { standings, fixtures, players, playersPartial: partial };
}

// ---- openfootball ----

// openfootball gives UK local kick-off times; convert them to UTC.
function londonToISO(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const london = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (london - utc)).toISOString();
}

async function fromOpenfootball(season) {
  const id = `${season}-${String(season + 1).slice(2)}`;
  const res = await fetch(`${OPENFOOTBALL}/${id}/en.1.json`);
  if (!res.ok) throw new Error(`openfootball ${id}: HTTP ${res.status}`);
  const matches = (await res.json()).matches
    .map(m => ({
      ...m,
      // Most scores are { ft: [h, a] } but some goalless draws are a bare [0, 0].
      ft: Array.isArray(m.score) ? m.score : m.score?.ft || null,
      kickoff: m.time ? londonToISO(m.date, m.time) : `${m.date}T12:00:00.000Z`
    }))
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));

  const rows = {};
  const row = team => rows[team] || (rows[team] = { team, us: team === OPENFOOTBALL_TEAM, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, results: [] });
  for (const m of matches) {
    row(m.team1); row(m.team2);
    if (!m.ft) continue;
    const [h, a] = m.ft;
    for (const [team, f, ag] of [[m.team1, h, a], [m.team2, a, h]]) {
      const r = row(team);
      const res = resultOf(f, ag);
      r.p++; r.gf += f; r.ga += ag; r.results.push(res);
      if (res === "W") r.w++; else if (res === "L") r.l++; else r.d++;
    }
  }

  const standings = Object.values(rows)
    .map(({ results, ...r }) => ({ ...r, gd: r.gf - r.ga, pts: r.w * 3 + r.d, form: results.slice(-5) }))
    .sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.team.localeCompare(y.team))
    .map((r, i) => ({ rank: i + 1, ...r }));

  const fixtures = matches
    .filter(m => m.team1 === OPENFOOTBALL_TEAM || m.team2 === OPENFOOTBALL_TEAM)
    .map(m => {
      const home = m.team1 === OPENFOOTBALL_TEAM;
      const [gf, ga] = m.ft ? (home ? m.ft : [m.ft[1], m.ft[0]]) : [null, null];
      return {
        kickoff: m.kickoff,
        status: m.ft ? "FT" : m.time ? "NS" : "TBD",
        home,
        opponent: home ? m.team2 : m.team1,
        gf, ga,
        result: m.ft ? resultOf(gf, ga) : null
      };
    });

  return { standings, fixtures, players: [], playersPartial: false };
}

// ---- main ----

async function fetchSeason({ season, source }) {
  const data = await (source === "api-football" ? fromApiFootball(season) : fromOpenfootball(season));
  return {
    season,
    label: `${season}/${String(season + 1).slice(2)}`,
    source,
    updated: new Date().toISOString(),
    live: data.fixtures.some(f => !f.result),
    ...data
  };
}

// Writes the file only if the data changed, so unchanged runs make no commit.
async function save(file, data) {
  const strip = d => JSON.stringify({ ...d, updated: null });
  if (existsSync(file) && strip(JSON.parse(await readFile(file, "utf8"))) === strip(data)) return false;
  await writeFile(file, JSON.stringify(data, null, 1) + "\n");
  return true;
}

await mkdir(OUT, { recursive: true });

const failures = [];
let changed = false;
for (const [i, entry] of SEASONS.entries()) {
  const file = new URL(`${entry.season}.json`, OUT);
  if (i > 0 && existsSync(file)) continue;
  try {
    const data = await fetchSeason(entry);
    changed = (await save(file, data)) || changed;
    console.log(`${data.label} (${entry.source}): ${data.standings.length} clubs, ${data.fixtures.length} fixtures, ${data.players.length} players${data.playersPartial ? " (partial)" : ""}`);
  } catch (err) {
    failures.push(`${entry.season}: ${err.message}`);
    console.error(`${entry.season}: ${err.message}`);
  }
}

// The page builds its season buttons from this list.
const seasons = SEASONS.map(s => s.season).filter(s => existsSync(new URL(`${s}.json`, OUT))).map(String);
const indexFile = new URL("index.json", OUT);
const previous = existsSync(indexFile) ? JSON.parse(await readFile(indexFile, "utf8")) : null;
if (changed || JSON.stringify(previous?.seasons) !== JSON.stringify(seasons)) {
  await writeFile(indexFile, JSON.stringify({ seasons, updated: new Date().toISOString() }, null, 1) + "\n");
}

console.log(`${calls} API-Football calls.`);
if (failures.length) {
  console.error(`Failed: ${failures.join(" | ")}`);
  process.exit(1);
}
