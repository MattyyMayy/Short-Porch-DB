# Short Porch DB

A New York Yankees season dashboard: record, AL East and American League
standings, runs by month, hitting and pitching stats, and the full schedule
including the postseason.

- `index.html` is the page. Serve it through GitHub Pages or any web
  server; it reads its data from `data/`.
- `scripts/fetch-data.mjs` pulls data from the free
  [MLB Stats API](https://statsapi.mlb.com/) (no key needed) and writes one
  JSON file per season to `data/`.
- `.github/workflows/update-data.yml` runs that script every 3 hours and
  commits any changes. Run it by hand from the Actions tab to fill `data/`
  the first time.

Data © MLB Advanced Media, L.P., subject to the terms at
http://gdx.mlb.com/components/copyright.txt.
