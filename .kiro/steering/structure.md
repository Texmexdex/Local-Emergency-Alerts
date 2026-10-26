# Project Structure

## Frontend (repo root, GitHub Pages)

- `index.html`: page layout (status banner, map, source cards, location dialog)
- `app.js`: fetches `/api/status`, NWS-direct fallback, rendering, Leaflet map, notifications, location settings (localStorage)
- `style.css`: design tokens with light/dark themes; level colors `--action/--warning/--advisory/--clear/--info`

## Backend (`api/`, Hugging Face Docker Space)

- `app.py`: Flask routes `/api/status`, `/api/geocode`, `/api/health`
- `emergency/config.py`: defaults (home location, radius, User-Agent, timezone)
- `emergency/http.py`: shared requests session + `TTLCache`
- `emergency/geo.py`: distance, bearing, compass, downwind exposure
- `emergency/geocode.py`: Census geocoder with caching; `KNOWN_SITES` approximate fallbacks
- `emergency/nws.py`, `caer.py`, `houston.py`: one module per source: fetch, parse, normalize, classify
- `emergency/assess.py`: combines sources into level + reasons
- `emergency/monitor.py`: ntfy notifier CLI (`python -m emergency.monitor`)
- `tests/`: pytest suite with HTML fixtures; no network access

## Automation (`.github/workflows/`)

- `tests.yml`: pytest on every push/PR
- `deploy-backend.yml`: pushes `api/` to the HF Space (needs `HF_TOKEN`)
- `monitor.yml`: every 10 min, ntfy push (needs `NTFY_TOPIC`)

## Patterns

- Each source fails independently; `assess.gather` records `ok/error` per source.
- Classification is rule-based (regexes in `caer.py`, `houston.py`, `nws.ACTION_EVENTS`). Add a fixture + test for any new rule.
- `app.js` `NWS_ACTION_EVENTS` mirrors `nws.ACTION_EVENTS`. Keep them in sync.
