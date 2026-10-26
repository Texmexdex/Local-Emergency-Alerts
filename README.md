# Local Emergency Alerts

**Is there an emergency near me right now, and what should I do?**

A dashboard for people living near the Houston Ship Channel's refineries and chemical plants. It checks official and industry sources every minute and gives one plain answer for *your* location:

| Level | Meaning | Examples |
|---|---|---|
| 🔴 **Act now** | Officials or a facility are telling people to protect themselves | Shelter In Place Warning, Hazardous Materials Warning, Tornado Warning, a CAER message telling neighbors to shelter or evacuate |
| 🟠 **Warning** | An emergency is happening nearby | Industrial release/fire/odor reported by a plant within your radius; hazmat or multi-alarm fire call nearby; severe weather warning; a minor plant incident when **you are downwind of it** |
| 🟡 **Advisory** | Worth knowing about | Flood/heat watches & advisories; plant upsets with possible smoke; a fire call within 3 miles |
| 🟢 **All clear** | Nothing found in the sources that responded | Routine flaring, drills and weekly alarm tests don't count |

If any source can't be reached, the page says so explicitly. It never shows a plain "all clear" when part of the picture is missing.

**Live site:** https://texmexdex.github.io/Local-Emergency-Alerts/

> ⚠️ Not an official warning system. Feeds can be delayed, incomplete or offline. Sign up for [Ready Harris Alerts](https://www.readyharris.org/), keep Wireless Emergency Alerts on, and follow instructions from local officials.

## What it checks

| Source | What it provides | Notes |
|---|---|---|
| [NWS alerts API](https://www.weather.gov/documentation/services-web-api) | Official alerts for your exact point, weather **and** non-weather (shelter in place, hazmat, civil emergency, evacuation) | The most authoritative source; also fetched straight from the browser if the backend is down |
| NWS station observations | **Measured** wind direction/speed from the nearest station | Used for downwind checks; falls back to the hourly forecast only if no station has a fresh reading |
| [CAER live postings](https://www.incident-reporter.net/e-notifycaerfeed/caermessagelive.html) | Community notifications posted by member plants (EHCMA e-Notify) | Each posting is classified: drill / all-clear / routine notice / incident / shelter-evacuate. Location comes from the address in the plant's own message |
| [City of Houston active incidents](https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx) | Live Fire/EMS calls | Addresses geocoded with the US Census geocoder. **City of Houston only**: unincorporated Harris County (Channelview, Sheldon, Crosby) isn't in this feed |
| [Open-Meteo air quality](https://open-meteo.com/en/docs/air-quality-api) | Regional AQI estimate | A model, not a monitor. It won't see a local plume. See AirNow for official readings |

### How "downwind" works

For every active industrial incident, it compares the observed wind with the direction from the plant to your home. If you're within ±30° of straight downwind and within 25 km (~15 mi), the incident is escalated and the page tells you *"the wind is blowing from this facility toward you"*. Under calm winds (< 5 km/h) vapors pool instead of travelling, so only plants within 5 km count. The map draws these downwind cones.

## Using it

- **Set your location**: click the 📍 location chip and enter your address (or use GPS). It's saved in your browser only. You can also share a link like `?lat=29.776&lon=-95.114&label=Home`.
- **Radius**: how far away an industrial or fire incident still counts as "near you" (default 10 mi).
- **Browser notifications / alarm sound**: alerts you when a new warning (or whatever level you pick) appears while the page is open, including in a background tab.
- **Phone push when the page is closed**: see [Phone alerts](#phone-alerts-ntfy) below.

## Architecture

```
GitHub Pages (index.html, app.js, style.css)
      │  GET /api/status?lat=&lon=&radius_mi=
      ▼
Hugging Face Docker Space (api/)  ── Flask + gunicorn
      ├─ emergency/nws.py      NWS alerts + observed wind
      ├─ emergency/caer.py     CAER feed parser + classifier
      ├─ emergency/houston.py  Houston Fire/EMS parser + classifier
      ├─ emergency/geocode.py  US Census geocoder (cached)
      ├─ emergency/assess.py   combines everything into one level + reasons
      └─ emergency/monitor.py  ntfy push notifier (run by GitHub Actions)
```

Free Hugging Face Spaces go to sleep when idle. If the backend takes more than 7 seconds, the page shows official NWS alerts fetched directly from weather.gov while the server wakes up, then fills in the industrial and fire data.

## Phone alerts (ntfy)

`.github/workflows/monitor.yml` runs every 10 minutes and pushes **new or escalated** items to your phone via [ntfy](https://ntfy.sh). It also sends an "All clear" once things end, and a one-time warning if the feeds have been unreachable for about an hour.

1. Install the ntfy app (iOS/Android) and subscribe to a long, random topic name, e.g. `lea-7f3k9q2m8x`. Anyone who knows the topic can read it.
2. In GitHub → Settings → Secrets and variables → Actions:
   - **Secret** `NTFY_TOPIC` = your topic name
   - **Variables** (optional) `HOME_LAT`, `HOME_LON`, `HOME_LABEL`, `RADIUS_MI` (default 10), `NOTIFY_MIN_LEVEL` (`action` / `warning` / `advisory`, default `warning`)
3. Run the workflow once manually (Actions → *Emergency monitor* → Run workflow) to check it works.

GitHub runs scheduled workflows on a best-effort basis (delays of several minutes happen) and pauses them after 60 days with no repository activity. Treat this as a backup to Ready Harris / WEA, not a replacement.

## Development

```bash
cd api
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt pytest
pytest -q                         # parser/classifier/assessment tests (no network)
python app.py                     # API on http://127.0.0.1:7860
python -m emergency.monitor --dry-run   # see what would be pushed
```

Then serve the frontend from the repo root (`python -m http.server 8000`) and open http://localhost:8000. On localhost it automatically talks to `http://127.0.0.1:7860/api`; elsewhere you can point it at any backend with `?api=https://.../api`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for deploying the frontend and backend.

---

TeXmExDeX Type Tools
