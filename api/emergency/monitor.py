"""Push notifications for new emergencies, via ntfy (https://ntfy.sh).

Runs the same assessment as the dashboard and sends one push per new (or
escalated) reason at or above --min-level, plus a single "all clear" once
everything has ended. State is kept in a small JSON file so repeated runs
don't re-send the same alert.

    python -m emergency.monitor --lat 29.7761 --lon -95.1144 --topic my-secret-topic

Install the ntfy app on your phone and subscribe to the same topic name.
Anyone who knows the topic can read it, so make it long and random.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

from . import assess, config, http

PRIORITY = {"action": "5", "warning": "4", "advisory": "3"}
TAGS = {"action": "rotating_light", "warning": "warning", "advisory": "information_source"}
KEEP_FOR = timedelta(days=3)
BLIND_IF_DOWN = ("nws_alerts", "caer")
BLIND_RUNS_BEFORE_WARNING = 6  # ~1 hour at the workflow's 10-minute schedule


def load_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"seen": {}, "last_level": "clear"}


def save_state(path, state):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=1)


def _ascii(s):
    return re.sub(r"[^\x20-\x7e]", "", s or "")[:200]


def plan_notifications(result, state, min_level="warning", now=None):
    """Decide what to send. Returns (messages, new_state). Pure: no I/O."""
    now = now or datetime.now(timezone.utc)
    min_rank = assess.LEVELS.index(min_level)
    seen = {
        k: v for k, v in state.get("seen", {}).items()
        if now - datetime.fromisoformat(v["at"]) < KEEP_FOR
    }
    messages = []
    for r in result["reasons"]:
        rank = assess.LEVELS.index(r["level"])
        prev = seen.get(r["id"])
        if rank >= min_rank and (prev is None or rank > assess.LEVELS.index(prev["level"])):
            where = []
            if r.get("distance_mi") is not None:
                where.append(f"{r['distance_mi']} mi {r.get('direction') or ''}".strip())
            body = " | ".join(x for x in (r.get("detail"), r.get("note"), ", ".join(where)) if x)
            if r.get("instruction"):
                body += "\n\n" + r["instruction"]
            messages.append({
                "title": f"{r['level'].upper()}: {r['title']}",
                "body": body[:3500],
                "level": r["level"],
                "url": r.get("url"),
            })
        if prev is None or rank > assess.LEVELS.index(prev["level"]):
            seen[r["id"]] = {"level": r["level"], "at": now.isoformat()}
        else:
            prev["at"] = now.isoformat()

    last = state.get("last_level", "clear")
    if (result["level"] == "clear" and result["complete"]
            and assess.LEVELS.index(last) >= min_rank):
        messages.append({
            "title": "All clear",
            "body": f"No active emergencies found near {result['location']['label']}.",
            "level": "advisory",
            "url": None,
        })
    # If the key feeds keep failing, say so once rather than going silently blind.
    sources = result.get("sources", {})
    blind = all(not sources.get(k, {}).get("ok", True) for k in BLIND_IF_DOWN)
    blind_runs = state.get("blind_runs", 0) + 1 if blind else 0
    if blind_runs == BLIND_RUNS_BEFORE_WARNING:
        messages.append({
            "title": "Monitor can't reach emergency feeds",
            "body": "The NWS and CAER feeds have been unreachable for about an hour. "
                    "Phone alerts from this tool are not working; rely on official alerts until this clears.",
            "level": "advisory",
            "url": None,
        })

    # A "clear" with sources down isn't trustworthy, so keep the previous level.
    unverified_clear = result["level"] == "clear" and not result["complete"]
    new_state = {"seen": seen, "last_level": last if unverified_clear else result["level"], "blind_runs": blind_runs}
    return messages, new_state


def send_ntfy(server, topic, msg, click_url=None):
    headers = {
        "Title": _ascii(msg["title"]),
        "Priority": PRIORITY.get(msg["level"], "3"),
        "Tags": TAGS.get(msg["level"], "information_source"),
    }
    if click_url or msg.get("url"):
        headers["Click"] = click_url or msg["url"]
    http.post(f"{server.rstrip('/')}/{topic}", data=msg["body"].encode("utf-8"), headers=headers)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lat", type=float, default=config.DEFAULT_LAT)
    p.add_argument("--lon", type=float, default=config.DEFAULT_LON)
    p.add_argument("--label", default=os.environ.get("HOME_LABEL", config.DEFAULT_LABEL))
    p.add_argument("--radius-mi", type=float, default=float(os.environ.get("RADIUS_MI", "10")))
    p.add_argument("--topic", default=os.environ.get("NTFY_TOPIC"))
    p.add_argument("--server", default=os.environ.get("NTFY_SERVER", "https://ntfy.sh"))
    p.add_argument("--min-level", default=os.environ.get("NOTIFY_MIN_LEVEL", "warning"),
                   choices=["advisory", "warning", "action"])
    p.add_argument("--state", default=os.environ.get("STATE_FILE", ".monitor-state/state.json"))
    p.add_argument("--dashboard-url", default=os.environ.get("DASHBOARD_URL"))
    p.add_argument("--dry-run", action="store_true", help="print instead of sending")
    args = p.parse_args(argv)

    if not args.topic and not args.dry_run:
        p.error("--topic (or NTFY_TOPIC) is required unless --dry-run")

    result = assess.assess(args.lat, args.lon, radius_km=args.radius_mi / 0.621371, label=args.label)
    state = load_state(args.state)
    messages, new_state = plan_notifications(result, state, args.min_level)

    print(f"{result['generated_at']} level={result['level']} reasons={len(result['reasons'])} "
          f"failed={result['failed_sources'] or 'none'} to_send={len(messages)}")
    failures = 0
    for m in messages:
        if args.dry_run:
            print(f"--- {m['title']}\n{m['body']}\n")
            continue
        try:
            send_ntfy(args.server, args.topic, m, args.dashboard_url)
        except Exception as exc:
            failures += 1
            print(f"send failed: {exc}", file=sys.stderr)
    if not failures:
        save_state(args.state, new_state)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
