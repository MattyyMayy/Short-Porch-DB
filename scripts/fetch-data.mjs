// Fetches Manchester United data from API-Football and writes it to data/ as JSON
// for Stretford.html to read. Runs in GitHub Actions so the API key stays secret.
//
// Usage: API_FOOTBALL_KEY=... node scripts/fetch-data.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const API = process.env.API_FOOTBALL_URL || "https://v3.football.api-sports.io";
const KEY = process.env.API_FOOTBALL_KEY;
const LEAGUE = 39; // Premier League
const TEAM = 33;   // Manchester United
const OUT = new URL("../data/", import.meta.url);

// API-Football names a season by its starting year: 2026 = 2026/27.
// The first entry is the current season and is refreshed on every run;
// earlier seasons are only fetched once, when their file is missing.
const SEASONS = [2026, 2025, 2024];

// Free plans allow 10 requests a minute.
const DELAY_MS = 7000;
const FINISHED = new Set(["FT", "AET", "PEN"]);

if (!KEY) {
  console.error("API_FOOTBALL_KEY is not set.");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0;

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

async function standings(season) {
  const body = await api(`standings?league=${LEAGUE}&season=${season}`);
  const table = body.response[0]?.league?.standings?.[0] || [];
  return table.map(r => ({
    rank: r.rank,
    team: r.team.name,
    teamId: r.team.id,
    p: r.all.played, w: r.all.win, d: r.all.draw, l: r.all.lose,
    gf: r.all.goals.for, ga: r.all.goals.against,
    gd: r.goalsDiff, pts: r.points,
    form: (r.form || "").split("").filter(c => "WDL".includes(c))
  }));
}

async function fixtures(season) {
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
        result: done ? (gf > ga ? "W" : gf < ga ? "L" : "D") : null
      };
    })
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}

async function players(season) {
  const out = [];
  for (let page = 1, total = 1; page <= total; page++) {
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
  return out;
}

async function fetchSeason(season) {
  const data = {
    season,
    label: `${season}/${String(season + 1).slice(2)}`,
    updated: new Date().toISOString(),
    standings: await standings(season),
    fixtures: await fixtures(season),
    players: await players(season)
  };
  data.live = data.fixtures.some(f => !f.result);
  return data;
}

await mkdir(OUT, { recursive: true });

// Writes the file only if the data changed, so unchanged runs make no commit.
async function save(file, data) {
  const strip = d => JSON.stringify({ ...d, updated: null });
  if (existsSync(file) && strip(JSON.parse(await readFile(file, "utf8"))) === strip(data)) return false;
  await writeFile(file, JSON.stringify(data, null, 1) + "\n");
  return true;
}

const failures = [];
let changed = false;
for (const [i, season] of SEASONS.entries()) {
  const file = new URL(`${season}.json`, OUT);
  if (i > 0 && existsSync(file)) continue;
  try {
    const data = await fetchSeason(season);
    changed = (await save(file, data)) || changed;
    console.log(`${data.label}: ${data.standings.length} clubs, ${data.fixtures.length} fixtures, ${data.players.length} players`);
  } catch (err) {
    failures.push(`${season}: ${err.message}`);
    console.error(`${season}: ${err.message}`);
  }
}

// The page builds its season buttons from this list.
const seasons = SEASONS.filter(s => existsSync(new URL(`${s}.json`, OUT))).map(String);
const indexFile = new URL("index.json", OUT);
const previous = existsSync(indexFile) ? JSON.parse(await readFile(indexFile, "utf8")) : null;
if (changed || JSON.stringify(previous?.seasons) !== JSON.stringify(seasons)) {
  await writeFile(indexFile, JSON.stringify({ seasons, updated: new Date().toISOString() }, null, 1) + "\n");
}

console.log(`${calls} API calls.`);
if (failures.length) {
  console.error(`Failed: ${failures.join(" | ")}`);
  process.exit(1);
}
