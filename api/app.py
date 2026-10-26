"""Local Emergency Alerts API (deployed as a Hugging Face Docker Space).

GET /api/status?lat=29.77&lon=-95.11[&radius_mi=10][&label=Home]
    One combined assessment: overall level, the reasons for it, and the
    normalized data from every source.
GET /api/geocode?q=<address or place>
    Look up coordinates for a home address.
GET /api/health
"""
from datetime import datetime, timezone

from flask import Flask, jsonify, request
from flask_cors import CORS

from emergency import assess, config, geocode, http
from emergency.http import TTLCache

app = Flask(__name__)
CORS(app)

_place_cache = TTLCache(ttl_seconds=24 * 3600)


def _float_arg(name, default, lo, hi):
    raw = request.args.get(name)
    if raw in (None, ""):
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number")
    if not lo <= value <= hi:
        raise ValueError(f"{name} must be between {lo} and {hi}")
    return value


@app.get("/api/status")
def status():
    try:
        lat = _float_arg("lat", config.DEFAULT_LAT, 18, 72)
        lon = _float_arg("lon", config.DEFAULT_LON, -180, -60)
        radius_km = config.DEFAULT_RADIUS_KM
        if request.args.get("radius_mi"):
            radius_km = _float_arg("radius_mi", 10, 1, 50) / 0.621371
        elif request.args.get("radius_km"):
            radius_km = _float_arg("radius_km", radius_km, 1, 80)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    label = (request.args.get("label") or "").strip()[:80] or None
    if label is None and (lat, lon) == (config.DEFAULT_LAT, config.DEFAULT_LON):
        label = config.DEFAULT_LABEL
    resp = jsonify(assess.assess(lat, lon, radius_km=radius_km, label=label))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/geocode")
def geocode_endpoint():
    q = (request.args.get("q") or "").strip()[:200]
    if len(q) < 3:
        return jsonify({"error": "q is required"}), 400
    results = []
    hit = geocode.geocode(q)
    if hit:
        results.append({"lat": hit["lat"], "lon": hit["lon"], "label": hit["matched"].title()})
    else:
        results = _place_cache.get_or_fetch(q.lower(), lambda: _nominatim(q))
    return jsonify({"query": q, "results": results})


def _nominatim(q):
    """Fallback for place names ("Channelview, TX") that Census can't match."""
    try:
        rows = http.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": q, "format": "jsonv2", "limit": 5, "countrycodes": "us"},
        ).json()
    except Exception:
        return []
    return [{"lat": float(r["lat"]), "lon": float(r["lon"]), "label": r.get("display_name", q)} for r in rows]


@app.get("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "time": datetime.now(timezone.utc).isoformat(),
        "default_location": {"lat": config.DEFAULT_LAT, "lon": config.DEFAULT_LON, "label": config.DEFAULT_LABEL},
        "sources": {k: name for k, (name, _) in assess.SOURCES.items()},
    })


@app.get("/")
def index():
    return jsonify({"service": "Local Emergency Alerts API", "endpoints": ["/api/status", "/api/geocode", "/api/health"]})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7860, threaded=True)
