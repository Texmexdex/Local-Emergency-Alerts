# Local Emergency Alerts: Worker

Cloudflare Worker that serves the dashboard's data and runs the phone-push monitor. See [DEPLOYMENT.md](../DEPLOYMENT.md) for setup.

## Endpoints

### `GET /api/status`

| Param | Default | |
|---|---|---|
| `lat`, `lon` | Highlands, TX | Home location (US only) |
| `radius_mi` or `radius_km` | 10 mi | How far an industrial/fire incident still counts as "near" |
| `label` | | Display name for the location |

```jsonc
{
  "level": "clear | advisory | warning | action",
  "headline": "Emergency activity near you",
  "reasons": [ { "id", "level", "source": "NWS|CAER|HFD", "title", "detail", "note",
                 "instruction", "time", "expires", "distance_mi", "direction", "url" } ],
  "downwind_of": ["LyondellBasell - Channelview"],
  "complete": true,            // false if any source failed
  "failed_sources": [],
  "sources": { "nws_alerts": { "ok": true, "error": null, "count": 0 }, ... },
  "alerts": [...],             // normalized NWS alerts (with polygons)
  "weather": {...},            // observed wind/temp
  "caer": [...],               // every CAER posting, classified, with distance
  "fire": [...]                // Houston FD incidents, geocoded where possible
}
```

### `GET /api/geocode?q=<address>`
US Census geocoder, with an OpenStreetMap Nominatim fallback for place names.

### `GET /api/health`
Includes `monitor.enabled` (true once the `STATE` KV binding and `NTFY_TOPIC` secret are set).

## Cron

`*/2 * * * *` runs `src/monitor.js`: assess `HOME_LAT`/`HOME_LON`, push new or escalated reasons at or above `NOTIFY_MIN_LEVEL` to ntfy, and store what was sent in KV (written only on change).

## Development

```bash
npm install
npm test          # node:test, no network
npm run dev       # http://127.0.0.1:8787 ; trigger cron with /__scheduled
```
