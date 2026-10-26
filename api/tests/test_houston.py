from conftest import NOW, fixture_text

from emergency import houston, http


def test_parse_table_maps_headers_and_skips_disclaimer():
    rows = houston.parse_table(fixture_text("houston.html"))
    assert len(rows) == 5
    assert rows[0] == {
        "agency": "FD", "address": "1000 MAIN ST", "cross_street": "LAMAR ST", "key_map": "493P",
        "call_time": "10/26/2026 13:02", "type": "HAZMAT - GAS LEAK", "combined": "N",
    }


def test_fetch_incidents_geocodes_and_classifies(monkeypatch):
    class R:
        text = fixture_text("houston.html")
    monkeypatch.setattr(http, "get", lambda url, **kw: R())
    downtown = (29.7604, -95.3698)
    incidents = houston.fetch_incidents(*downtown, now=NOW)
    by_type = {i["type"]: i for i in incidents}

    assert "MAJOR ACCIDENT" not in by_type  # police calls dropped
    hazmat = by_type["HAZMAT - GAS LEAK"]
    assert hazmat["level"] == "warning" and hazmat["kind"] == "hazmat"
    assert hazmat["distance_km"] < 2
    assert hazmat["called_at"] == "2026-10-26T13:02:00-05:00"
    assert by_type["STRUCTURE FIRE - RESIDENTIAL"]["level"] == "advisory"
    assert by_type["FIRE ALARM - COMMERCIAL"]["level"] == "info"
    # Ungeocodable address: no fake coordinates.
    unknown = by_type["CHECK PATIENT"]
    assert unknown["lat"] is None and unknown["distance_km"] is None


def test_far_incidents_do_not_count():
    row = {"type": "HAZMAT", "address": "x"}
    assert houston.classify(row, 30)[0] == "info"
    assert houston.classify(row, None)[0] == "info"
    assert houston.classify({"type": "STRUCTURE FIRE", "alarm": "2"}, 6)[0] == "warning"


def test_time_only_call_times_roll_back_a_day():
    assert houston.parse_call_time("13:02", NOW).isoformat() == "2026-10-26T13:02:00-05:00"
    assert houston.parse_call_time("23:50", NOW).isoformat() == "2026-10-25T23:50:00-05:00"
    assert houston.parse_call_time("garbage", NOW) is None
