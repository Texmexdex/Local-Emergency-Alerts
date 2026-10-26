# Project Structure

## Frontend (repo root, GitHub Pages)

- `index.html`: page layout (status banner, map, source cards, location dialog)
- `config.js`: `apiBase` URL of the deployed Worker
- `app.js`: fetches `/api/status`, NWS-direct fallback, rendering, Leaflet map, notifications, location settings (localStorage)
- `style.css`: design tokens with light/dark themes; level colors `--action/--warning/--advisory/--clear/--info`

## Backend (`worker/`, Cloudflare Worker)

- `src/index.js`: routes `/api/status`, `/api/geocode`, `/api/health`; `scheduled()` runs the monitor
- `src/config.js`: defaults (home location, radius, User-Agent, timezone)
- `src/http.js`: fetch helpers, per-isolate `TTLCache`, Houston local-time conversion, HTML-to-text
- `src/geo.js`: distance, bearing, compass, downwind exposure
- `src/geocode.js`: Census one-line + batch geocoder, caching, KV persistence, `KNOWN_SITES` approximate fallbacks
- `src/nws.js`, `caer.js`, `houston.js`: one module per source: fetch, parse, normalize, classify
- `src/assess.js`: combines sources into level + reasons
- `src/monitor.js`: ntfy notifier (cron), state in the `STATE` KV namespace
- `test/`: `node:test` suite with HTML fixtures; `helpers.js` mocks `fetch` (no network)
- `wrangler.toml`: cron schedule, `[vars]` (home location), optional KV binding

## Automation (`.github/workflows/`)

- `tests.yml`: Worker tests plus a `wrangler deploy --dry-run` bundle check on every push/PR
- Deploys happen through Cloudflare's Git integration (or `npx wrangler deploy`), not GitHub Actions

## Patterns

- Each source fails independently; `assess.gather` records `ok/error` per source.
- Classification is rule-based (regexes in `caer.js`, `houston.js`, `ACTION_EVENTS` in `nws.js`). Add a fixture + test for any new rule.
- `app.js` `NWS_ACTION_EVENTS` mirrors `ACTION_EVENTS` in `worker/src/nws.js`. Keep them in sync.
- Free-plan limits shape the code: 10 ms CPU (regex parsing, 60 s feed cache), 50 subrequests (batch geocoding, capped one-line lookups), KV writes only on change.
