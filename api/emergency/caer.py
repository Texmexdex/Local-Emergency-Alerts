"""CAER / EHCMA community notifications from Houston-area industrial facilities.

Source: https://www.incident-reporter.net/e-notifycaerfeed/caermessagelive.html

The page lists one <h5> heading per facility posting::

    <h5>PEMEX Deer Park, Posted On - 8/13/2026 7:21:00 AM</h5>
    Posted On - 8/13/2026 7:21:00 AM - Update 7<br>
    This is an update from PEMEX Deer Park. ...<br><br>

followed by one "Posted On - <time> - <label>" entry per update (newest
first). Most postings are routine: planned flaring, weekly alarm tests,
drills and all-clears. The classifier below is deliberately strict so those
do not raise an alarm, while real releases, fires, odours and protective
actions (shelter in place / evacuate) do.
"""
import hashlib
import re
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup, NavigableString, Tag

from . import config, geo, geocode, http
from .http import TTLCache

FEED_URL = "https://www.incident-reporter.net/e-notifycaerfeed/caermessagelive.html"

_cache = TTLCache(ttl_seconds=60)
_facility_addresses = {}  # facility name -> last address seen in its messages

DATE_FORMATS = ["%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %I:%M %p", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M"]
POSTED_RE = re.compile(r"^Posted On\s*-\s*(?P<dt>\d{1,2}/\d{1,2}/\d{4}[^-]*?)\s*(?:-\s*(?P<rest>.*))?$", re.I)
LABEL_RE = re.compile(
    r"^(?P<label>Initial Report|Initial|Update(?:\s*#?\s*\d+)?|All Clear|Final Report|Final|Clear|Report)\b[\s:.-]*(?P<text>.*)$",
    re.I,
)
# e.g. "located at 12342 Strang Rd. La Porte,TX 77571-0347" (abbreviations contain periods)
ADDRESS_RE = re.compile(r"located (?:at|on) (?P<addr>\d[^;]{3,90}?,?\s*TX,?\s*\d{5})(?:-\d{4})?\b", re.I)

DRILL_RE = re.compile(
    r"\bdrill\b|\bexercise\b|\btraining\b|weekly alarm|alarm test|siren test|test(?:ing)? (?:of )?(?:the |our )?(?:alarm|siren)|test alarm",
    re.I,
)
CLEAR_RE = re.compile(r"\ball[ -]?clear\b|\b(?:has|have) (?:been )?(?:ended|concluded|lifted|secured)\b|\bconcluded\b", re.I)
PROTECTIVE_RE = re.compile(
    r"shelter[- ]in[- ]place|\bevacuat\w*|stay indoors|remain indoors|close (?:all |your )?(?:doors|windows)"
    r"|turn off (?:your )?(?:air|a/c|ac|hvac|ventilation)",
    re.I,
)
PROTECTIVE_NEGATED_RE = re.compile(
    r"\b(?:no|not|lifted|lift|lifting|ended|cancel\w*|without)\b[^.]{0,40}(?:shelter|evacuat)"
    r"|(?:shelter[- ]in[- ]place|evacuation\w*)[^.]{0,30}\b(?:lifted|ended|cancel\w*|no longer)\b",
    re.I,
)
SEVERE_RE = re.compile(
    r"\b(?:releas\w*|leak\w*|fire|fires|explosion|exploded|odou?rs?|smoke|vapou?rs?|chemical|spill\w*|plume|haze"
    r"|injur\w*|hazard\w*|roads? (?:closure|closed|blocked)|closed? (?:the )?road)\b",
    re.I,
)
INCIDENT_RE = re.compile(r"\bincident\b|\bemergency\b|\bupset\b|\bunplanned\b|\bunexpected\b", re.I)
PLANNED_RE = re.compile(r"\bflar\w*|\bsteam\b|\bnoise\b|\bplanned\b|maintenance|start-?up|shut-?down|turnaround|courtesy", re.I)
REASSURE_RE = re.compile(
    r"no (?:off-?site|community) (?:impact|threat|danger|risk)"
    r"|do(?:es)? not (?:anticipate|expect) any (?:impact|threat|danger|risk)"
    r"|not (?:expected|anticipated) to (?:impact|affect|pose|leave)"
    r"|no (?:threat|danger|risk|impact) (?:to|on) (?:the )?(?:public|community|neighbors)"
    r"|no action is required|contained (?:on-?site|within)|remain(?:s|ed)? on-?site",
    re.I,
)


def clean(text):
    return re.sub(r"\s+", " ", (text or "").replace("\xa0", " ")).strip()


def parse_local_time(text):
    text = clean(text)
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=config.LOCAL_TZ)
        except ValueError:
            continue
    return None


def _block_text(heading):
    """All text between this <h5> and the next one, with <br> as newlines."""
    parts = []
    for el in heading.next_elements:
        if isinstance(el, Tag) and el.name == "h5":
            break
        if isinstance(el, NavigableString) and el.parent is not heading:
            parts.append(str(el))
    return "".join(parts)


def parse_feed(html):
    """Parse the CAER page into postings (one per facility heading)."""
    html = re.sub(r"<\s*/?\s*br\s*/?\s*>", "\n", html, flags=re.I)
    soup = BeautifulSoup(html, "html.parser")
    postings = []
    for h5 in soup.find_all("h5"):
        heading = clean(h5.get_text(" "))
        facility, _, heading_time = heading.partition("Posted On - ")
        facility = facility.strip(" ,")
        if not facility:
            continue
        entries = []
        for line in _block_text(h5).split("\n"):
            line = clean(line)
            if not line:
                continue
            m = POSTED_RE.match(line)
            if m:
                label, text = "", ""
                lm = LABEL_RE.match(m.group("rest") or "")
                if lm:
                    label, text = lm.group("label"), lm.group("text")
                elif m.group("rest"):
                    text = m.group("rest")
                entries.append({"posted": parse_local_time(m.group("dt")), "label": clean(label), "text": text})
            elif entries:
                entries[-1]["text"] = clean(entries[-1]["text"] + " " + line)
            else:
                entries.append({"posted": parse_local_time(heading_time), "label": "", "text": line})
        entries = [e for e in entries if e["text"]]
        if not entries:
            continue
        fallback = parse_local_time(heading_time)
        for e in entries:
            e["posted"] = e["posted"] or fallback
        epoch = datetime.min.replace(tzinfo=timezone.utc)
        entries.sort(key=lambda e: e["posted"] or epoch, reverse=True)
        postings.append({"facility": facility, "entries": entries})
    return postings


def classify(text, label=""):
    """Return (level, kind). level is action/warning/advisory/info."""
    t = text or ""
    if DRILL_RE.search(t) and not re.search(r"\bthis is not a drill\b", t, re.I):
        return "info", "drill"
    if "clear" in (label or "").lower() or CLEAR_RE.search(t):
        return "info", "all_clear"
    if PROTECTIVE_RE.search(t) and not PROTECTIVE_NEGATED_RE.search(t):
        return "action", "protective_action"
    reassured = bool(REASSURE_RE.search(t))
    severe = bool(SEVERE_RE.search(t))
    if severe and not reassured and not PLANNED_RE.search(t):
        return "warning", "incident"
    if (severe or INCIDENT_RE.search(t)) and not reassured:
        return "advisory", "incident"
    return "info", "notice"


def _remember_address(facility, entries):
    for e in entries:
        m = ADDRESS_RE.search(e["text"])
        if m:
            _facility_addresses[facility] = m.group("addr")
            return


def _locate(facility, entries):
    _remember_address(facility, entries)
    addr = _facility_addresses.get(facility)
    loc = geocode.geocode(addr) if addr else None
    return addr, loc or geocode.known_site(facility)


def build_posting(raw, home_lat, home_lon, now):
    facility, entries = raw["facility"], raw["entries"]
    latest = entries[0]
    level, kind = classify(latest["text"], latest["label"])
    first_time = entries[-1]["posted"]
    pid = hashlib.sha1(f"{facility}|{first_time.isoformat() if first_time else ''}".encode()).hexdigest()[:16]
    addr, loc = _locate(facility, entries)
    posted = latest["posted"]
    age_h = None if posted is None else (now - posted).total_seconds() / 3600
    item = {
        "id": f"caer-{pid}",
        "facility": facility,
        "label": latest["label"] or "Notice",
        "text": latest["text"],
        "posted_at": posted.isoformat() if posted else None,
        "age_hours": None if age_h is None else round(age_h, 1),
        "level": level,
        "kind": kind,
        "address": addr,
        "lat": loc["lat"] if loc else None,
        "lon": loc["lon"] if loc else None,
        "location_approximate": bool(loc and loc["approximate"]),
        "distance_km": None,
        "bearing_from_home": None,
        "updates": [
            {"posted_at": e["posted"].isoformat() if e["posted"] else None, "label": e["label"], "text": e["text"]}
            for e in entries[1:]
        ],
        "url": FEED_URL,
    }
    if loc:
        item["distance_km"] = round(geo.distance_km(home_lat, home_lon, loc["lat"], loc["lon"]), 1)
        item["bearing_from_home"] = geo.compass(geo.bearing_deg(home_lat, home_lon, loc["lat"], loc["lon"]))
    return item


def fetch_postings(home_lat, home_lon, now=None):
    now = now or datetime.now(timezone.utc)
    raw = _cache.get_or_fetch("feed", lambda: parse_feed(http.get(FEED_URL).text))
    for r in raw:
        _remember_address(r["facility"], r["entries"])
    # Warm the geocode cache in parallel; build_posting then reads from it.
    geocode.geocode_many(list({_facility_addresses[r["facility"]] for r in raw if r["facility"] in _facility_addresses}))
    postings = [build_posting(r, home_lat, home_lon, now) for r in raw]
    order = {"action": 0, "warning": 1, "advisory": 2, "info": 3}
    postings.sort(key=lambda p: (order[p["level"]], p["age_hours"] if p["age_hours"] is not None else 1e9))
    return postings


def is_current(posting, max_age=timedelta(hours=24)):
    return posting["age_hours"] is not None and posting["age_hours"] <= max_age.total_seconds() / 3600
