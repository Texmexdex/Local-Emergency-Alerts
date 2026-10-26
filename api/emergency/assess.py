"""Combine all sources into one answer: is there an emergency near me?

Levels, highest first:
  action   - official protective action (shelter in place, evacuate, tornado
             warning...) or an industrial message telling neighbours to act.
  warning  - an emergency is happening nearby: industrial release/fire,
             hazmat or major fire call, severe weather warning.
  advisory - something worth knowing: watches/advisories, minor industrial
             incidents, a nearby fire.
  clear    - nothing found in the sources that responded.
"""
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from . import caer, config, geo, houston, nws

LEVELS = ["clear", "info", "advisory", "warning", "action"]
HEADLINES = {
    "action": "Take protective action now",
    "warning": "Emergency activity near you",
    "advisory": "Be aware: activity near you",
    "clear": "No active emergencies found near you",
}
ESCALATE = {"advisory": "warning", "warning": "warning", "action": "action"}

SOURCES = {
    "nws_alerts": ("National Weather Service alerts", nws.fetch_alerts),
    "weather": ("NWS observed wind & weather", nws.fetch_weather),
    "caer": ("CAER industrial community notifications", caer.fetch_postings),
    "houston_fire": ("City of Houston Fire/EMS active incidents", houston.fetch_incidents),
}


def _rank(level):
    return LEVELS.index(level)


def _run(fetch, lat, lon):
    started = time.monotonic()
    try:
        data = fetch(lat, lon)
        return {"ok": True, "data": data, "error": None, "ms": int((time.monotonic() - started) * 1000)}
    except Exception as exc:  # each source fails independently
        return {"ok": False, "data": None, "error": f"{type(exc).__name__}: {exc}"[:300],
                "ms": int((time.monotonic() - started) * 1000)}


def gather(lat, lon, sources=None):
    sources = sources or SOURCES
    with ThreadPoolExecutor(max_workers=len(sources)) as pool:
        futures = {key: pool.submit(_run, fn, lat, lon) for key, (_, fn) in sources.items()}
        return {key: f.result() for key, f in futures.items()}


def _mi(km):
    return None if km is None else round(geo.km_to_mi(km), 1)


def build(lat, lon, results, radius_km=config.DEFAULT_RADIUS_KM, label=None, now=None):
    now = now or datetime.now(timezone.utc)
    alerts = results["nws_alerts"]["data"] or []
    weather = results["weather"]["data"]
    postings = results["caer"]["data"] or []
    fires = results["houston_fire"]["data"] or []
    reasons = []

    for a in alerts:
        if a["level"] == "info":
            continue
        reasons.append({
            "id": f"nws-{a['id']}",
            "level": a["level"],
            "source": "NWS",
            "title": a["event"],
            "detail": a["headline"],
            "instruction": a["instruction"],
            "time": a["effective"],
            "expires": a["ends"] or a["expires"],
            "distance_mi": None,
            "url": a["url"],
        })

    wind_from = weather.get("wind_from_deg") if weather else None
    wind_kmh = weather.get("wind_kmh") if weather else None
    downwind_of = []
    for p in postings:
        p["exposure"] = None
        if p["lat"] is not None and weather:
            p["exposure"] = geo.downwind_exposure(p["lat"], p["lon"], lat, lon, wind_from, wind_kmh)
        if p["level"] == "info" or not caer.is_current(p):
            continue
        d = p["distance_km"]
        in_range = d is None or d <= radius_km
        if p["exposure"] and d is not None and d <= geo.DOWNWIND_MAX_KM:
            in_range = True
        if not in_range:
            continue
        level = p["level"]
        note = []
        if p["exposure"] == "downwind":
            level = ESCALATE[level]
            note.append("the wind is blowing from this facility toward you")
            downwind_of.append(p["facility"])
        elif p["exposure"] == "calm-nearby":
            note.append("winds are calm, so odours or vapours may linger nearby")
        if d is None:
            note.append("facility location unknown")
        reasons.append({
            "id": p["id"],
            "level": level,
            "source": "CAER",
            "title": f"{p['facility']}: {'shelter/evacuate message' if p['kind'] == 'protective_action' else 'incident reported'}",
            "detail": p["text"],
            "note": "; ".join(note) or None,
            "instruction": None,
            "time": p["posted_at"],
            "expires": None,
            "distance_mi": _mi(d),
            "direction": p["bearing_from_home"],
            "url": p["url"],
        })

    for f in fires:
        if f["level"] == "info" or f["distance_km"] is None or f["distance_km"] > radius_km:
            continue
        reasons.append({
            "id": f["id"],
            "level": f["level"],
            "source": "HFD",
            "title": f"Houston Fire: {f['type']}",
            "detail": ", ".join(x for x in (f["address"], f["cross_street"]) if x),
            "instruction": None,
            "time": f["called_at"],
            "expires": None,
            "distance_mi": _mi(f["distance_km"]),
            "direction": f["bearing_from_home"],
            "url": f["url"],
        })

    reasons.sort(key=lambda r: (-_rank(r["level"]), r["distance_mi"] if r["distance_mi"] is not None else 1e9))
    level = reasons[0]["level"] if reasons else "clear"
    failed = [SOURCES[k][0] for k, r in results.items() if not r["ok"] and k in SOURCES]
    headline = HEADLINES[level]
    if level == "clear" and failed:
        headline = "No emergencies found in the sources that responded"

    return {
        "generated_at": now.isoformat(),
        "location": {"lat": lat, "lon": lon, "label": label or (weather or {}).get("place") or f"{lat:.4f}, {lon:.4f}"},
        "radius_km": radius_km,
        "radius_mi": _mi(radius_km),
        "level": level,
        "headline": headline,
        "reasons": reasons,
        "downwind_of": downwind_of,
        "complete": not failed,
        "failed_sources": failed,
        "sources": {
            k: {"name": SOURCES[k][0], "ok": r["ok"], "error": r["error"], "ms": r["ms"],
                "count": len(r["data"]) if isinstance(r["data"], list) else None}
            for k, r in results.items() if k in SOURCES
        },
        "alerts": alerts,
        "weather": weather,
        "caer": postings,
        "fire": fires,
    }


def assess(lat, lon, radius_km=config.DEFAULT_RADIUS_KM, label=None):
    return build(lat, lon, gather(lat, lon), radius_km=radius_km, label=label)
