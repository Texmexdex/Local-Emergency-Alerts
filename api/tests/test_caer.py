from conftest import HOME, NOW, fixture_text

from emergency import caer


def postings():
    return {p["facility"] + "|" + p["label"]: p for p in
            [caer.build_posting(r, *HOME, NOW) for r in caer.parse_feed(fixture_text("caer_feed.html"))]}


def test_parses_every_heading_with_real_posted_times():
    raw = caer.parse_feed(fixture_text("caer_feed.html"))
    assert len(raw) == 7
    pemex = raw[0]
    assert pemex["facility"] == "PEMEX Deer Park"
    assert [e["label"] for e in pemex["entries"]] == ["Update 7", "Update 6"]
    assert pemex["entries"][0]["posted"].isoformat() == "2026-10-26T07:21:00-05:00"
    assert pemex["entries"][0]["text"].startswith("This is an update from PEMEX Deer Park.")


def test_routine_messages_do_not_raise_alarm():
    p = postings()
    # Planned flaring that mentions smoke but says no community impact.
    assert p["PEMEX Deer Park|Update 7"]["level"] == "info"
    # Drill containing the word "emergency".
    assert p["Kuraray America La Porte|Initial Report"]["kind"] == "drill"
    assert p["Kuraray America La Porte|Initial Report"]["level"] == "info"
    # All clear containing the word "incident".
    assert p["Sekisui Specialty Chemicals|All Clear"]["kind"] == "all_clear"
    # Upset with explicit "no off-site impact".
    assert p["Sekisui Specialty Chemicals|Initial Report"]["level"] == "info"


def test_real_incidents_are_flagged():
    p = postings()
    lyb = p["LyondellBasell - Channelview|Initial Report"]
    assert (lyb["level"], lyb["kind"]) == ("warning", "incident")
    sip = p["Example Chemical Baytown|Update 1"]
    assert (sip["level"], sip["kind"]) == ("action", "protective_action")


def test_locations_come_from_message_address():
    lyb = postings()["LyondellBasell - Channelview|Initial Report"]
    assert lyb["address"] == "8280 Sheldon Rd Channelview,TX 77530"
    assert (lyb["lat"], lyb["lon"]) == (29.8325, -95.1170)
    assert lyb["location_approximate"] is False
    assert 6 < lyb["distance_km"] < 7
    assert lyb["bearing_from_home"] == "N"
    # Address with periods in it ("Strang Rd.") still extracted.
    assert postings()["Kuraray America La Porte|Initial Report"]["lat"] == 29.6960


def test_known_site_fallback_is_marked_approximate():
    pemex = postings()["PEMEX Deer Park|Update 7"]
    assert pemex["address"] is None
    assert pemex["location_approximate"] is True
    assert pemex["lat"] is not None


def test_age_and_currency():
    old = postings()["Old Plant Pasadena|Initial Report"]
    assert old["age_hours"] > 24
    assert not caer.is_current(old)
    assert caer.is_current(postings()["LyondellBasell - Channelview|Initial Report"])


def test_classifier_cases():
    c = caer.classify
    assert c("Residents should shelter in place immediately.")[0] == "action"
    assert c("Shelter in place has been lifted for the area.")[1] == "all_clear"
    assert c("There is no shelter in place in effect. A small leak was contained.")[0] != "action"
    assert c("Evacuate the area south of Hwy 225.")[0] == "action"
    assert c("A small fire broke out in a process unit. Smoke may be visible.")[0] == "warning"
    assert c("We are flaring due to a unit upset. Smoke may be visible.")[0] == "advisory"
    assert c("Weekly alarm test at noon.")[1] == "drill"
    assert c("THIS IS NOT A DRILL. Shelter in place now.")[0] == "action"
    assert c("Steam venting may be heard by nearby neighbors.")[0] == "info"


def test_fetch_postings_end_to_end(monkeypatch):
    class R:
        text = fixture_text("caer_feed.html")
    monkeypatch.setattr(caer.http, "get", lambda url, **kw: R())
    result = caer.fetch_postings(*HOME, now=NOW)
    assert [p["level"] for p in result][:2] == ["action", "warning"]
    assert sum(p["lat"] is not None for p in result) >= 5
