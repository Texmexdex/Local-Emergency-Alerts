# Product Overview

Local Emergency Alerts answers one question for people living near the Houston Ship Channel's industrial facilities: **is there an emergency near me right now, and what should I do?**

## Core behavior

- One overall level for the user's location: `action` > `warning` > `advisory` > `clear`, with a list of reasons (source, distance, direction, time) and plain-language guidance (e.g. shelter-in-place steps).
- Never report a plain "all clear" when a source failed; name the failed sources and link to them.
- Routine industrial postings (planned flaring, drills, weekly alarm tests, all-clears) must not raise the level.
- Wind-aware: an active industrial incident upwind of the user escalates, using *observed* wind.
- Notifications only for new or escalated items: browser notifications while the page is open; ntfy phone push from the Worker's cron trigger when it's closed.

## Data sources

- NWS alerts API (point-based; includes non-weather civil alerts like Shelter In Place Warning)
- NWS station observations (wind)
- CAER live postings (incident-reporter.net)
- City of Houston Fire/EMS active incidents (City of Houston only)
- US Census geocoder (addresses; batch endpoint for dispatch), Open-Meteo (modeled AQI)

## Accuracy rules

- Never invent coordinates. Ungeocodable incidents are listed as "not mapped".
- Use the timestamps the feeds publish (local Houston time), never the fetch time.
- Approximate facility locations must be flagged as approximate.
