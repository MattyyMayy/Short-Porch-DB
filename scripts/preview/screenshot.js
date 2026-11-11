// Screenshots the dashboard for previews. Serve a preview site first, e.g.:
//   mkdir -p /tmp/site/data && python3 scripts/preview/fake-data.py data /tmp/site/data
//   ln -sf "$PWD/index.html" /tmp/site/index.html && python3 -m http.server 8765 -d /tmp/site &
// then: node scripts/preview/screenshot.js <out-dir> [url]
// Add steps below for whatever the change touches.
const { chromium } = require("playwright");

(async () => {
  const out = process.argv[2] || ".";
  const url = process.argv[3] || "http://localhost:8765/";
  const b = await chromium.launch();
  const watch = p => {
    p.on("pageerror", e => console.log("pageerror:", e.message));
    p.on("console", m => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log("console:", m.text()));
  };

  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  watch(p);
  await p.goto(url, { waitUntil: "networkidle" }).catch(() => {});
  await p.waitForSelector("#players tr");
  await p.screenshot({ path: `${out}/desktop-full.png`, fullPage: true });
  const players = p.locator("section.card", { has: p.locator("#players") });
  if (await p.locator("#players tr.player").count()) {
    await p.click("#players tr.player:nth-child(1) td.name");
    await p.hover("#players .trend-chart .hit[data-i='2']").catch(() => {});
    await players.screenshot({ path: `${out}/desktop-player-chart.png` });
  }

  // Each player table, with age, height and weight at the right end.
  for (const g of ["hitters", "pitchers", "fielders"]) {
    await p.selectOption("#group", g).catch(() => {});
    await p.waitForTimeout(200);
    await players.screenshot({ path: `${out}/desktop-${g}.png` });
  }
  await p.selectOption("#group", "hitters").catch(() => {});
  await p.selectOption("#sort", "age").catch(() => {});
  await p.waitForTimeout(200);
  await players.screenshot({ path: `${out}/desktop-hitters-by-age.png` });

  const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  watch(m);
  await m.goto(url, { waitUntil: "networkidle" }).catch(() => {});
  await m.waitForSelector("#players tr");
  await m.screenshot({ path: `${out}/mobile-full.png`, fullPage: true });
  await m.emulateMedia({ colorScheme: "dark" });
  await m.screenshot({ path: `${out}/mobile-dark.png` });
  const mPlayers = m.locator("section.card", { has: m.locator("#players") });
  await mPlayers.screenshot({ path: `${out}/mobile-dark-players.png` });
  await m.locator("#players-box").evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await mPlayers.screenshot({ path: `${out}/mobile-dark-players-right.png` });

  await b.close();
})();
