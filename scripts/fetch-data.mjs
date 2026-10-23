// Fetches New York Yankees data from the MLB Stats API and writes it to data/
// as JSON for index.html to read. Runs in GitHub Actions on a schedule.
// The API is free and needs no key.
//
// Usage: node scripts/fetch-data.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const API = process.env.MLB_API_URL || "https://statsapi.mlb.com/api/v1";
const TEAM = 147;      // New York Yankees
const LEAGUE = 103;    // American League
const DIVISION = 201;  // AL East
const OUT = new URL("../data/", import.meta.url);

// Regular season plus the four postseason rounds; spring training and
// exhibitions are left out.
const GAME_TYPES = new Set(["R", "F", "D", "L", "W"]);
const NOT_PLAYED = /postponed|cancel|suspended/i;

// Bump when the shape of the season files changes, so past seasons (which
// are otherwise only fetched once) are fetched again.
const DATA_VERSION = 3;

// The first season is the current one and is refreshed on every run; the
// others are only fetched once, when their file is missing. A new season
// starts with spring training, so roll over in March.
const now = new Date();
const CURRENT = now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const SEASONS = [0, 1, 2, 3, 4].map(n => CURRENT - n);

const resultOf = (f, a) => (f > a ? "W" : f < a ? "L" : "T");
const num = v => (v == null || v === "" || v === "-" || v === ".---" ? null : Number(v));
let calls = 0;

// Network blips ("fetch failed"), timeouts, rate limits and server errors
// are retried with backoff; other HTTP errors fail at once.
const RETRIES = 4;
const TIMEOUT_MS = 30_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path) {
  for (let attempt = 0; ; attempt++) {
    calls++;
    let res, problem;
    try {
      res = await fetch(`${API}/${path}`, {
        headers: { "user-agent": "short-porch-db" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) return await res.json();
      problem = `HTTP ${res.status}`;
    } catch (err) {
      const cause = err.cause?.code || err.cause?.message;
      problem = `${err.message}${cause ? ` (${cause})` : ""}`;
    }
    if (res && !res.ok && res.status !== 429 && res.status < 500) throw new Error(`${path}: ${problem}`);
    if (attempt >= RETRIES) throw new Error(`${path}: ${problem}`);
    console.warn(`${path}: ${problem}, retrying`);
    await sleep(1000 * 2 ** attempt);
  }
}

function split(teamRecord, type) {
  const s = teamRecord.records?.splitRecords?.find(r => r.type === type);
  return s ? `${s.wins}-${s.losses}` : null;
}

async function standings(season) {
  const body = await api(`standings?leagueId=${LEAGUE}&season=${season}&standingsTypes=regularSeason&hydrate=team`);
  return (body.records || []).flatMap(rec => (rec.teamRecords || []).map(r => ({
    team: r.team.name,
    abbr: r.team.abbreviation || null,
    us: r.team.id === TEAM,
    division: rec.division?.id === DIVISION,
    divRank: num(r.divisionRank),
    leagueRank: num(r.leagueRank),
    w: r.wins, l: r.losses,
    pct: r.winningPercentage,
    gb: r.gamesBack,
    wcgb: r.wildCardGamesBack ?? null,
    rs: r.runsScored, ra: r.runsAllowed,
    rd: r.runDifferential ?? r.runsScored - r.runsAllowed,
    home: split(r, "home"),
    away: split(r, "away"),
    l10: split(r, "lastTen"),
    streak: r.streak?.streakCode || null,
    clinched: r.clinchIndicator || null
  })));
}

// Inning-by-inning runs plus R/H/E, away team first as on a scoreboard.
// An inning a team didn't bat in (a home win in the 9th) is null.
function lineScore(g) {
  const ls = g.linescore;
  if (!ls?.innings?.length || !ls.teams) return null;
  const side = s => ({
    team: g.teams[s].team.abbreviation || g.teams[s].team.name,
    innings: ls.innings.map(i => i[s]?.runs ?? null),
    r: ls.teams[s].runs ?? g.teams[s].score ?? null,
    h: ls.teams[s].hits ?? null,
    e: ls.teams[s].errors ?? null
  });
  return { away: side("away"), home: side("home") };
}

async function schedule(season) {
  const body = await api(`schedule?sportId=1&teamId=${TEAM}&startDate=${season}-02-01&endDate=${season}-12-15&hydrate=team,linescore`);
  return (body.dates || [])
    .flatMap(d => d.games || [])
    .filter(g => GAME_TYPES.has(g.gameType))
    .map(g => {
      const home = g.teams.home.team.id === TEAM;
      const us = home ? g.teams.home : g.teams.away;
      const them = home ? g.teams.away : g.teams.home;
      const state = g.status?.detailedState || "";
      const done = g.status?.abstractGameState === "Final" && !NOT_PLAYED.test(state) && us.score != null && them.score != null;
      return {
        id: g.gamePk,
        date: g.officialDate || g.gameDate.slice(0, 10),
        start: g.gameDate,
        timeTBD: !!g.status?.startTimeTBD,
        type: g.gameType,
        series: g.gameType === "R" ? null : g.seriesDescription || null,
        game: g.doubleHeader !== "N" ? g.gameNumber : null,
        state: g.status?.abstractGameState || "Preview",
        status: state,
        home,
        opponent: them.team.name,
        oppAbbr: them.team.abbreviation || null,
        rf: done ? us.score : null,
        ra: done ? them.score : null,
        result: done ? resultOf(us.score, them.score) : null,
        line: done || g.status?.abstractGameState === "Live" ? lineScore(g) : null
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

async function playerStats(season, group) {
  const body = await api(`stats?stats=season&group=${group}&gameType=R&season=${season}&teamId=${TEAM}&sportId=1&playerPool=ALL&limit=200`);
  return (body.stats?.[0]?.splits || []).map(sp => ({
    id: sp.player.id,
    name: sp.player.fullName,
    pos: sp.position?.abbreviation || null,
    s: sp.stat
  }));
}

async function hitters(season) {
  return (await playerStats(season, "hitting"))
    .filter(p => p.s.plateAppearances > 0)
    .map(({ s, ...p }) => ({
      ...p,
      g: s.gamesPlayed, pa: s.plateAppearances, ab: s.atBats,
      h: s.hits, hr: s.homeRuns, rbi: s.rbi, r: s.runs, sb: s.stolenBases,
      bb: s.baseOnBalls, so: s.strikeOuts,
      avg: num(s.avg), obp: num(s.obp), slg: num(s.slg), ops: num(s.ops)
    }));
}

// "180.1" innings means 180 and one third.
const outs = ip => {
  const [whole, part = "0"] = String(ip ?? "0").split(".");
  return Number(whole) * 3 + Number(part);
};

async function pitchers(season) {
  return (await playerStats(season, "pitching"))
    .filter(p => outs(p.s.inningsPitched) > 0)
    .map(({ s, ...p }) => ({
      ...p,
      g: s.gamesPlayed, gs: s.gamesStarted,
      w: s.wins, l: s.losses, sv: s.saves, hld: s.holds,
      ip: String(s.inningsPitched), outs: outs(s.inningsPitched),
      so: s.strikeOuts, bb: s.baseOnBalls,
      era: num(s.era), whip: num(s.whip)
    }));
}

// One row per player per position played; DH has no fielding to show.
async function fielders(season) {
  return (await playerStats(season, "fielding"))
    .filter(p => p.pos && p.pos !== "DH" && outs(p.s.innings) > 0)
    .map(({ s, ...p }) => ({
      ...p,
      g: s.gamesPlayed, gs: s.gamesStarted,
      inn: String(s.innings), outs: outs(s.innings),
      tc: s.chances, po: s.putOuts, a: s.assists, e: s.errors, dp: s.doublePlays,
      fpct: num(s.fielding), rf9: num(s.rangeFactorPer9Inn)
    }));
}

// Team batting by month, and the same line for opponents (the pitching
// group's stats are what was hit against us). Regular season only. The API
// has no team split by month, so per-game logs are added up; the page works
// out the rate stats from these counts.
const LINE = {
  g: "gamesPlayed", r: "runs", ab: "atBats", h: "hits", d: "doubles", t: "triples", hr: "homeRuns",
  bb: "baseOnBalls", hbp: "hitByPitch", sf: "sacFlies", so: "strikeOuts"
};

async function byMonth(season, group) {
  const body = await api(`teams/${TEAM}/stats?stats=gameLog&group=${group}&season=${season}&gameType=R`);
  const months = new Map();
  for (const { date, stat: s } of body.stats?.[0]?.splits || []) {
    const m = Number(date?.slice(5, 7));
    if (!m) continue;
    const line = months.get(m) || Object.fromEntries(["pa", ...Object.keys(LINE)].map(k => [k, 0]));
    for (const [k, field] of Object.entries(LINE)) line[k] += s[field] ?? 0;
    line.pa += s.plateAppearances ?? s.battersFaced ?? 0;
    months.set(m, line);
  }
  return months;
}

async function monthly(season) {
  const [bat, opp] = await Promise.all([byMonth(season, "hitting"), byMonth(season, "pitching")]);
  return [...new Set([...bat.keys(), ...opp.keys()])]
    .sort((a, b) => a - b)
    .map(m => ({ m, bat: bat.get(m) || null, opp: opp.get(m) || null }));
}

async function fetchSeason(season) {
  const [table, games, bats, arms, gloves, months] = await Promise.all([
    standings(season), schedule(season), hitters(season), pitchers(season), fielders(season), monthly(season)
  ]);
  return {
    season,
    label: String(season),
    source: "mlb-statsapi",
    version: DATA_VERSION,
    updated: new Date().toISOString(),
    live: games.some(g => !g.result && !NOT_PLAYED.test(g.status)),
    standings: table,
    games,
    hitters: bats,
    pitchers: arms,
    fielders: gloves,
    months
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
// A file left over from another source (the old football data) or an older
// data version is fetched again.
async function isCurrent(file) {
  if (!existsSync(file)) return false;
  try {
    const d = JSON.parse(await readFile(file, "utf8"));
    return d.source === "mlb-statsapi" && d.version === DATA_VERSION;
  } catch {
    return false;
  }
}

for (const [i, season] of SEASONS.entries()) {
  const file = new URL(`${season}.json`, OUT);
  if (i > 0 && await isCurrent(file)) continue;
  try {
    const data = await fetchSeason(season);
    // Before Opening Day the current season has no games yet; skip it so the
    // page opens on the last season instead of an empty one.
    if (!data.games.length) {
      console.log(`${season}: no games found, skipped.`);
      continue;
    }
    changed = (await save(file, data)) || changed;
    console.log(`${season}: ${data.standings.length} teams, ${data.games.length} games, ${data.hitters.length} hitters, ${data.pitchers.length} pitchers, ${data.fielders.length} fielders`);
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

console.log(`${calls} MLB Stats API calls.`);
if (failures.length) {
  console.error(`Failed: ${failures.join(" | ")}`);
  process.exit(1);
}
