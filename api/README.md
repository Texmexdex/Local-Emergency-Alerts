---
title: Local Emergency Alerts API
emoji: 🚨
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Local Emergency Alerts API

Backend for [Local Emergency Alerts](https://github.com/texmexdex/local-emergency-alerts). It combines NWS alerts, observed wind, CAER industrial notifications and City of Houston Fire/EMS incidents into one assessment for a location.

## Endpoints

### `GET /api/status`

| Param | Default | |
|---|---|---|
| `lat`, `lon` | Channelview, TX | Home location (US only) |
| `radius_mi` or `radius_km` | 10 mi | How far an industrial/fire incident still counts as "near" |
| `label` | | Display name for the location |

Returns:

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

## Running locally

```bash
pip install -r requirements.txt pytest
pytest -q
python app.py   # http://127.0.0.1:7860
```

Upstream responses are cached in memory (alerts/feeds 60 s, observations 5 min, geocodes 7 days), so many viewers don't multiply requests to the source sites.
