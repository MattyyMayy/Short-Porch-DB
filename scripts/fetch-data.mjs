// Fetches New York Yankees data from the MLB Stats API and writes it to data/
// as JSON for ShortPorch.html to read. Runs in GitHub Actions on a schedule.
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

// The first season is the current one and is refreshed on every run; the
// others are only fetched once, when their file is missing. A new season
// starts with spring training, so roll over in March.
const now = new Date();
const CURRENT = now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const SEASONS = [0, 1, 2, 3, 4].map(n => CURRENT - n);

const resultOf = (f, a) => (f > a ? "W" : f < a ? "L" : "T");
const num = v => (v == null || v === "" || v === "-" || v === ".---" ? null : Number(v));
let calls = 0;

async function api(path) {
  calls++;
  const res = await fetch(`${API}/${path}`, { headers: { "user-agent": "short-porch-db" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
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

async function schedule(season) {
  const body = await api(`schedule?sportId=1&teamId=${TEAM}&startDate=${season}-02-01&endDate=${season}-12-15`);
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
        rf: done ? us.score : null,
        ra: done ? them.score : null,
        result: done ? resultOf(us.score, them.score) : null
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

async function fetchSeason(season) {
  const [table, games, bats, arms] = await Promise.all([
    standings(season), schedule(season), hitters(season), pitchers(season)
  ]);
  return {
    season,
    label: String(season),
    source: "mlb-statsapi",
    updated: new Date().toISOString(),
    live: games.some(g => !g.result && !NOT_PLAYED.test(g.status)),
    standings: table,
    games,
    hitters: bats,
    pitchers: arms
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
// A file left over from another source (the old football data) is fetched again.
async function isCurrent(file) {
  if (!existsSync(file)) return false;
  try {
    return JSON.parse(await readFile(file, "utf8")).source === "mlb-statsapi";
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
    console.log(`${season}: ${data.standings.length} teams, ${data.games.length} games, ${data.hitters.length} hitters, ${data.pitchers.length} pitchers`);
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
