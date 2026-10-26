# Technology Stack

- **Frontend**: plain HTML/CSS/JS (no build step), Leaflet 1.9.4 from unpkg, CARTO basemap tiles
- **Backend**: Cloudflare Worker (JavaScript ES modules, no runtime dependencies), Wrangler 4 for dev/deploy, KV for monitor state
- **Hosting**: GitHub Pages (frontend), Cloudflare Workers free plan (backend + cron)
- **Notifications**: Web Notifications API + WebAudio in the browser; ntfy.sh from the Worker's cron trigger
- **Tests**: Node 22 `node:test`, with `fetch` mocked against HTML/JSON fixtures

## Commands

```bash
cd worker
npm install
npm test                      # tests
npm run dev                   # Worker at http://127.0.0.1:8787 (cron: /__scheduled)
npx wrangler deploy           # deploy
python -m http.server 8000    # (from repo root) serve the frontend
```

All upstream sources are public and need no API keys. NWS requires a descriptive User-Agent (set in `worker/src/config.js`).
