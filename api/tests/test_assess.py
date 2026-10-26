from datetime import timedelta

from conftest import HOME, NOW, fixture_text

from emergency import assess, caer, geo, monitor, nws


def nws_feature(event, severity="Severe", status="Actual", **extra):
    return {"id": f"urn:{event}", "properties": {
        "id": f"urn:{event}", "event": event, "headline": f"{event} issued", "severity": severity,
        "urgency": "Immediate", "status": status, "description": "desc", "instruction": "Do this.",
        "effective": "2026-10-26T13:00:00-05:00", "expires": "2026-10-26T15:00:00-05:00", **extra,
    }}


def test_nws_levels():
    lvl = lambda e, s: nws.alert_level({"event": e, "severity": s})
    assert lvl("Shelter In Place Warning", "Unknown") == "action"
    assert lvl("Hazardous Materials Warning", "Severe") == "action"
    assert lvl("Tornado Warning", "Extreme") == "action"
    assert lvl("Flash Flood Warning", "Extreme") == "action"
    assert lvl("Severe Thunderstorm Warning", "Severe") == "warning"
    assert lvl("Flood Watch", "Moderate") == "advisory"
    assert lvl("Heat Advisory", "Minor") == "advisory"
    assert lvl("Special Weather Statement", "Minor") == "info"


def test_nws_fetch_drops_test_messages(monkeypatch):
    class R:
        def json(self):
            return {"features": [nws_feature("Flood Watch", "Moderate"),
                                 nws_feature("Tornado Warning", "Extreme"),
                                 nws_feature("Civil Emergency Message", status="Test")]}
    monkeypatch.setattr(nws.http, "get", lambda *a, **k: R())
    alerts = nws.fetch_alerts(*HOME)
    assert [a["event"] for a in alerts] == ["Tornado Warning", "Flood Watch"]


def test_observation_units():
    w = nws.parse_observation({
        "timestamp": "2026-10-26T18:00:00+00:00", "windDirection": {"value": 180},
        "windSpeed": {"value": 16.09}, "windGust": {"value": None}, "temperature": {"value": 25},
        "relativeHumidity": {"value": 70.4}, "textDescription": "Cloudy",
    }, {"id": "KHOU"})
    assert (w["wind_from"], w["wind_mph"], w["temp_f"], w["humidity"]) == ("S", 10, 77, 70)


def test_downwind_geometry():
    src = (29.70, -95.11)  # south of home
    assert geo.downwind_exposure(*src, *HOME, wind_from_deg=180, wind_kmh=15) == "downwind"
    assert geo.downwind_exposure(*src, *HOME, wind_from_deg=0, wind_kmh=15) is None
    assert geo.downwind_exposure(*src, *HOME, wind_from_deg=0, wind_kmh=2) is None  # calm but 8 km away
    assert geo.downwind_exposure(29.79, -95.11, *HOME, wind_from_deg=0, wind_kmh=2) == "calm-nearby"


def ok(data):
    return {"ok": True, "data": data, "error": None, "ms": 1}


def caer_postings():
    return [caer.build_posting(r, *HOME, NOW) for r in caer.parse_feed(fixture_text("caer_feed.html"))]


def weather(from_deg, kmh=15):
    return {"wind_from_deg": from_deg, "wind_kmh": kmh, "place": "Channelview, TX"}


def test_clear_when_nothing_relevant():
    results = {"nws_alerts": ok([]), "weather": ok(weather(180)), "caer": ok([]), "houston_fire": ok([])}
    r = assess.build(*HOME, results, radius_km=16, now=NOW)
    assert r["level"] == "clear" and r["complete"]
    assert r["headline"] == "No active emergencies found near you"


def test_failed_source_is_never_reported_as_all_clear():
    results = {"nws_alerts": ok([]), "weather": ok(weather(180)), "caer": ok([]),
               "houston_fire": {"ok": False, "data": None, "error": "Timeout", "ms": 1}}
    r = assess.build(*HOME, results, now=NOW)
    assert not r["complete"]
    assert r["failed_sources"] == ["City of Houston Fire/EMS active incidents"]
    assert "sources that responded" in r["headline"]


def test_industrial_incidents_drive_level():
    results = {"nws_alerts": ok([]), "weather": ok(weather(270)), "caer": ok(caer_postings()), "houston_fire": ok([])}
    r = assess.build(*HOME, results, radius_km=16, now=NOW)
    assert r["level"] == "action"
    titles = [x["title"] for x in r["reasons"]]
    assert titles[0] == "Example Chemical Baytown: shelter/evacuate message"
    assert "LyondellBasell - Channelview: incident reported" in titles
    assert not any("PEMEX" in t or "Kuraray" in t or "Old Plant" in t for t in titles)


def test_downwind_escalates_and_is_explained():
    lyb_only = [p for p in caer_postings() if p["facility"].startswith("Lyondell")]
    for p in lyb_only:
        p["level"] = "advisory"
    # LyondellBasell is north of home; a north wind carries air south to us.
    results = {"nws_alerts": ok([]), "weather": ok(weather(0)), "caer": ok(lyb_only), "houston_fire": ok([])}
    r = assess.build(*HOME, results, now=NOW)
    assert r["level"] == "warning"
    assert r["downwind_of"] == ["LyondellBasell - Channelview"]
    assert "blowing from this facility toward you" in r["reasons"][0]["note"]


def test_out_of_radius_postings_ignored_unless_downwind():
    far = [p for p in caer_postings() if p["facility"].startswith("Lyondell")]
    results = {"nws_alerts": ok([]), "weather": ok(weather(180)), "caer": ok(far), "houston_fire": ok([])}
    assert assess.build(*HOME, results, radius_km=3, now=NOW)["level"] == "clear"
    results["weather"] = ok(weather(0))
    assert assess.build(*HOME, results, radius_km=3, now=NOW)["level"] == "warning"


def test_nws_alert_becomes_reason():
    alerts = [nws.normalize_alert(nws_feature("Shelter In Place Warning", "Unknown"))]
    results = {"nws_alerts": ok(alerts), "weather": ok(None), "caer": ok([]), "houston_fire": ok([])}
    r = assess.build(*HOME, results, now=NOW)
    assert r["level"] == "action"
    assert r["reasons"][0]["instruction"] == "Do this."


def test_monitor_sends_once_then_escalation_then_all_clear():
    base = {"location": {"label": "Home"}, "complete": True}
    reason = {"id": "x1", "level": "advisory", "title": "Thing", "detail": "d", "distance_mi": 2.0, "direction": "N"}
    state = {"seen": {}, "last_level": "clear"}

    msgs, state = monitor.plan_notifications({**base, "level": "advisory", "reasons": [reason]}, state, "warning", NOW)
    assert msgs == []  # below threshold
    msgs, state = monitor.plan_notifications(
        {**base, "level": "warning", "reasons": [{**reason, "level": "warning"}]}, state, "warning", NOW)
    assert [m["title"] for m in msgs] == ["WARNING: Thing"]
    assert "2.0 mi N" in msgs[0]["body"]
    msgs, state = monitor.plan_notifications(
        {**base, "level": "warning", "reasons": [{**reason, "level": "warning"}]}, state, "warning", NOW)
    assert msgs == []  # no repeats
    msgs, state = monitor.plan_notifications(
        {**base, "level": "clear", "complete": False, "reasons": []}, state, "warning", NOW)
    assert msgs == []  # unverified clear: wait
    msgs, state = monitor.plan_notifications({**base, "level": "clear", "reasons": []}, state, "warning", NOW)
    assert [m["title"] for m in msgs] == ["All clear"]
    msgs, state = monitor.plan_notifications({**base, "level": "clear", "reasons": []}, state, "warning",
                                             NOW + timedelta(minutes=10))
    assert msgs == []


def test_monitor_warns_once_when_feeds_stay_down():
    down = {"ok": False}
    result = {"location": {"label": "Home"}, "complete": False, "level": "clear", "reasons": [],
              "sources": {"nws_alerts": down, "caer": down, "weather": down, "houston_fire": down}}
    state = {"seen": {}, "last_level": "clear"}
    sent = []
    for _ in range(8):
        msgs, state = monitor.plan_notifications(result, state, "warning", NOW)
        sent += msgs
    assert [m["title"] for m in sent] == ["Monitor can't reach emergency feeds"]
    result["sources"]["nws_alerts"] = {"ok": True}
    _, state = monitor.plan_notifications(result, state, "warning", NOW)
    assert state["blind_runs"] == 0
