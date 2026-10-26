import app as app_module
from emergency import assess


def fake_gather(lat, lon, sources=None):
    ok = {"ok": True, "error": None, "ms": 1}
    return {"nws_alerts": {**ok, "data": []}, "weather": {**ok, "data": None},
            "caer": {**ok, "data": []}, "houston_fire": {**ok, "data": []}}


def test_status_endpoint(monkeypatch):
    monkeypatch.setattr(assess, "gather", fake_gather)
    client = app_module.app.test_client()
    r = client.get("/api/status?lat=29.7&lon=-95.2&radius_mi=5&label=Home")
    assert r.status_code == 200
    body = r.get_json()
    assert body["level"] == "clear"
    assert body["location"] == {"lat": 29.7, "lon": -95.2, "label": "Home"}
    assert round(body["radius_mi"]) == 5
    assert r.headers["Access-Control-Allow-Origin"] == "*"


def test_status_defaults_to_channelview(monkeypatch):
    monkeypatch.setattr(assess, "gather", fake_gather)
    body = app_module.app.test_client().get("/api/status").get_json()
    assert body["location"]["label"] == "Channelview, TX"


def test_status_rejects_bad_input():
    client = app_module.app.test_client()
    assert client.get("/api/status?lat=abc").status_code == 400
    assert client.get("/api/status?lat=10&lon=-95").status_code == 400
    assert client.get("/api/geocode").status_code == 400
