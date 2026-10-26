import os
from zoneinfo import ZoneInfo

# Default "home" location: Channelview, TX (north side of the Houston Ship Channel).
# Every request can override this with ?lat=&lon=.
DEFAULT_LAT = float(os.environ.get("HOME_LAT", "29.7761"))
DEFAULT_LON = float(os.environ.get("HOME_LON", "-95.1144"))
DEFAULT_LABEL = os.environ.get("HOME_LABEL", "Channelview, TX")

# Radius used to decide whether an industrial or fire incident is "near you".
DEFAULT_RADIUS_KM = float(os.environ.get("RADIUS_KM", "16"))  # ~10 miles

# NWS requires a descriptive User-Agent with contact info.
USER_AGENT = os.environ.get(
    "USER_AGENT",
    "LocalEmergencyAlerts/2.0 (+https://github.com/texmexdex/local-emergency-alerts)",
)

# Feed timestamps (CAER postings, Houston call times) are local Houston time.
LOCAL_TZ = ZoneInfo("America/Chicago")

HTTP_TIMEOUT = float(os.environ.get("HTTP_TIMEOUT", "12"))
