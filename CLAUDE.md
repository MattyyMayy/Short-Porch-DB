# Short Porch DB

Static Yankees dashboard: `index.html` (one page, no build step) reads JSON
from `data/`, which `scripts/fetch-data.mjs` writes from the MLB Stats API on
a schedule (`.github/workflows/update-data.yml`). See README.md.

## Previewing changes (always do this)

For every change to the page, preview it with fake data and send the owner
screenshots before finishing:

1. If the change needs data the files don't have yet, extend
   `scripts/preview/fake-data.py` to make it up. Fake data goes in a scratch
   directory only; never commit it to `data/`.
2. Serve the page with that data and run `scripts/preview/screenshot.js`
   (add steps for the feature being changed). Check desktop, phone width,
   and dark mode.
3. Look at the screenshots yourself, fix anything off, then send them to the
   owner with a short caption of what each shows.

## Notes

- The MLB Stats API may be unreachable from cloud sessions; write fetch code
  from the API's documented shapes and say it couldn't be run.
- Bump `DATA_VERSION` in `scripts/fetch-data.mjs` when the shape of the season
  files changes, so past seasons are fetched again.
- Keep the page's pixel/pinstripe style and light/dark theme tokens.
