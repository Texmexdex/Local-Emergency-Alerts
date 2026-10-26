# Technology Stack

- **Frontend**: plain HTML/CSS/JS (no build step), Leaflet 1.9.4 from unpkg, CARTO basemap tiles
- **Backend**: Python 3.12, Flask, flask-cors, requests, BeautifulSoup, gunicorn (1 worker, 8 threads so caches are shared), tzdata
- **Hosting**: GitHub Pages (frontend), Hugging Face Docker Space on port 7860 (backend)
- **Notifications**: Web Notifications API + WebAudio in the browser; ntfy.sh via GitHub Actions

## Commands

```bash
cd api
pip install -r requirements.txt pytest
pytest -q                               # tests
python app.py                           # API at http://127.0.0.1:7860
python -m emergency.monitor --dry-run   # preview phone notifications
python -m http.server 8000              # (from repo root) serve the frontend
```

All upstream sources are public and need no API keys. NWS requires a descriptive User-Agent (set in `emergency/config.py`).
