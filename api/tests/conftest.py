import os
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from emergency import caer, config, geocode, houston, nws  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
# 1:30 PM Houston time on the fixture day.
NOW = datetime(2026, 10, 26, 13, 30, tzinfo=config.LOCAL_TZ)
HOME = (29.7761, -95.1144)  # Channelview

# Fake geocoder results keyed by normalized upper-case address.
GEOCODES = {
    "8280 SHELDON RD CHANNELVIEW, TX 77530": (29.8325, -95.1170),
    "100 EXAMPLE RD BAYTOWN, TX 77520": (29.7600, -95.0000),
    "1423 HIGHWAY 225 PASADENA, TX 77506": (29.7230, -95.1900),
    "12342 STRANG RD. LA PORTE, TX 77571": (29.6960, -95.0710),
    "1000 MAIN ST, HOUSTON, TX": (29.7560, -95.3630),
    "2000 SMITH ST, HOUSTON, TX": (29.7520, -95.3720),
    "3000 FANNIN ST, HOUSTON, TX": (29.7420, -95.3780),
}


def fixture_text(name):
    return (FIXTURES / name).read_text()


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    """No network in tests: fake the geocoder and reset every cache."""
    def fake_lookup(query):
        hit = GEOCODES.get(query.upper())
        return {"lat": hit[0], "lon": hit[1], "matched": query, "approximate": False} if hit else None

    monkeypatch.setattr(geocode, "_census_lookup", fake_lookup)
    for cache in (geocode._cache, caer._cache, houston._cache, nws._alerts_cache, nws._points_cache, nws._obs_cache):
        cache.clear()
    caer._facility_addresses.clear()
    os.environ.pop("NTFY_TOPIC", None)
    yield
