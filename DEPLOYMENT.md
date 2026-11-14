# Deployment

Two free pieces, neither of which sleeps:

- **Data server**: a Cloudflare Worker built from the `worker/` folder.
- **Website**: GitHub Pages serving `index.html`, `app.js`, `style.css` and `config.js` from the repository root.

## 1. Deploy the Worker

You need a free Cloudflare account: https://dash.cloudflare.com/sign-up. When it asks, choose your **workers.dev subdomain**. Your Worker's address will be `https://local-emergency-alerts.<subdomain>.workers.dev`.

### Option A: from the Cloudflare dashboard, deploying automatically from GitHub (no command line)

1. In the Cloudflare dashboard go to **Workers & Pages → Create** and choose to import a Git repository.
2. Connect GitHub and pick `Texmexdex/Local-Emergency-Alerts`.
3. Set the **root directory** to `worker`. Leave the deploy command as `npx wrangler deploy`.
4. Deploy. From then on, every push to `main` redeploys the Worker automatically.

(Cloudflare occasionally renames these screens; the steps are "create a Worker from a Git repository, with root directory `worker`".)

### Option B: from your computer

```bash
cd worker
npm install
npx wrangler login      # opens a browser to authorize
npx wrangler deploy     # prints your Worker URL
```

### Check it

Open `https://local-emergency-alerts.<subdomain>.workers.dev/api/status`. The `sources` block shows whether each upstream feed responded and, if not, the error. All four should say `"ok": true`.

> This is the first time the code talks to the real feeds, so this check matters. If `caer` or `houston_fire` shows an error such as `HTTP 403`, that site is refusing requests from Cloudflare's servers; the error text says which.

## 2. Point the website at the Worker

1. Edit `config.js` in the repo root:
   ```js
   window.LEA_CONFIG = {
       apiBase: 'https://local-emergency-alerts.<subdomain>.workers.dev/api',
   };
   ```
2. Commit and push to `main`.
3. If GitHub Pages isn't on yet: GitHub → Settings → Pages → *Deploy from a branch*, branch `main`, folder `/ (root)`. The site is at `https://texmexdex.github.io/Local-Emergency-Alerts/`.

## 3. Phone alerts (optional)

The Worker's cron trigger (every 2 minutes) pushes new emergencies to your phone through [ntfy](https://ntfy.sh). It needs somewhere to remember what it already sent (a KV namespace) and your ntfy topic.

1. **Create the KV namespace.**
   - Dashboard: *Storage & Databases → KV → Create*, name it `STATE`, and copy its ID.
   - Or command line: `cd worker && npx wrangler kv namespace create STATE`.
2. **Bind it.** In `worker/wrangler.toml`, uncomment the `[[kv_namespaces]]` block and paste the ID. (KV IDs aren't secret, so they're fine to commit.)
3. **Set your location** in `worker/wrangler.toml` under `[vars]`: `HOME_LAT`, `HOME_LON`, `HOME_LABEL`, `RADIUS_MI`, and `NOTIFY_MIN_LEVEL` (`action`, `warning` or `advisory`). Change these in the file, not the dashboard: each deploy resets dashboard variables to what's in `wrangler.toml`. Secrets are kept.
4. **Set the topic as a secret.**
   - Dashboard: your Worker → *Settings → Variables and Secrets → Add* → type *Secret*, name `NTFY_TOPIC`, value = your topic.
   - Or command line: `npx wrangler secret put NTFY_TOPIC`.
5. Push (or `npx wrangler deploy`). `/api/health` should now show `"monitor": {"enabled": true, ...}`.

The Worker's *Logs* tab shows one line per cron run, e.g. `level=clear reasons=0 failed=none sent=0`.

## 4. Plant (CAER) notifications, scanner alerts and texts from an Android phone (optional)

Since Oct 20, 2026 the public CAER web page requires a sign-in, but the **EHCMA CAER Online** app still sends push notifications to residents. A spare Android phone, plugged in on WiFi, can forward each notification it receives to your Worker. They're then classified, located and checked for wind direction like the old feed. This is your own copy of alerts sent to you, so keep it private and don't republish it.

1. **KV storage:** this needs the `STATE` KV namespace from step 3.
2. **Pick a long random token** (about 30+ characters; a password manager can generate one). In Cloudflare: your Worker → *Settings → Variables and Secrets → Add* → type **Secret**, name `INGEST_TOKEN`, value = the token. `/api/health` should then show `"phone_relay": {"enabled": true}`.
3. **On the phone, set up the CAER app:** install **EHCMA CAER Online**, open *Preferences*, turn on push notifications and choose every LEPC location it offers.
4. **Install the CAER Relay app** (built from `android/` in this repo):
   - On the phone, download `caer-relay.apk` from the repo's **Releases** page (the "CAER Relay (Android)" release), and allow your browser to install unknown apps when Android asks.
   - Open **Alert Relay** (called CAER Relay before version 2): the Worker address is prefilled; paste your `INGEST_TOKEN` as the relay password and tap **Save**.
   - Tap **1. Allow notification access** and switch CAER Relay on.
   - Tap **2. Don't let Android put this app to sleep** and set CAER Relay to *Unrestricted* / *Don't optimize*.
   - Tap **3. Send a test message**: it should say *delivered*.
   - It forwards notifications from the apps listed in its settings (default `CAER, CrimeRadar`) and nothing else, sends an hourly heartbeat (so the dashboard can tell a quiet phone from an offline one), queues messages while offline, and restarts its heartbeat after a reboot.
   - Updates are signed with a new key each build for now, so if Android refuses to install an update, uninstall the old CAER Relay first (and re-enter the password).
5. **Scanner alerts and official texts (same app, optional):**
   - **CrimeRadar** (by TownTalk) turns police/fire dispatch radio into written alerts. Install it, set your area, and allow its notifications. Alert Relay forwards it by default; the alerts appear in the dashboard's *Scanner reports & official texts* card and on the map, marked **unconfirmed**. They can raise the level to *advisory* at most, and only for serious keywords (hazmat, chemical, explosion, plant fire, shelter in place) within 5 mi.
   - **Ready Harris** isn't an app: sign up at [readyharris.org](https://www.readyharris.org/) for **text** alerts at your address. When the first one arrives, type the sender's name or number exactly as your Messages app shows it into *Forward texts from senders containing* and tap **Save**. Only texts from senders you list are forwarded; a shelter-in-place or evacuation text raises a *warning*.
   - Other apps: add their name to *Forward these apps* (comma-separated; whole words, so `X` matches the X app but not "Xfinity"). Turn off that app's notifications for anything you don't want forwarded (e.g. DMs).
6. **No-app alternative:** any forwarder that can send an HTTP POST works: POST the notification to `https://local-emergency-alerts.<subdomain>.workers.dev/api/ingest/notification?token=<your token>` (or send the token as `Authorization: Bearer <token>`) with the notification text as the body (JSON `{"title": ..., "text": ...}` or plain text). Add `&heartbeat=1` for an hourly heartbeat.
7. **Test from a computer:**
   ```bash
   curl -X POST "https://local-emergency-alerts.<subdomain>.workers.dev/api/ingest/notification" \
     -H "Authorization: Bearer <your token>" -H "Content-Type: application/json" \
     -d '{"title":"Test Facility","text":"*** DRILL *** This is a test notification."}'
   ```
   It should answer `{"stored":true,...}`, and the dashboard's Industrial notifications panel should say it's relayed from your phone. A drill won't raise any alarm.

## Free-plan budget

| Limit (free plan) | Usage |
|---|---|
| 100,000 requests/day | ~720 cron runs/day plus one request per open dashboard per minute |
| 10 ms CPU per invocation | Parsing a worst-case feed page takes ~2–3 ms, and parsed feeds are cached for 60 s |
| 50 outbound requests per invocation | About 10 when warm; up to ~25 the first time new addresses are geocoded |
| KV writes/day | Only when something changes: new alerts, new plant addresses |

## Troubleshooting

| Symptom | Check |
|---|---|
| Page says "Couldn't reach: CAER …; City of Houston …" | `config.js` `apiBase` is empty or wrong, or the Worker is down. Open `<apiBase>/health` |
| `/api/status` shows `caer` or `houston_fire` with `HTTP 403`/`503` | That upstream site is blocking or down. The rest of the page still works |
| Fire calls listed as "not mapped" | The Census geocoder couldn't match that dispatch address; it's still listed, just not placed on the map |
| Plant notifications panel says "not available" even with the phone set up | `/api/health` → `phone_relay.enabled` must be `true`, and the phone must have forwarded at least one notification or heartbeat |
| No phone alerts | `/api/health` → `monitor.enabled` must be `true`; check the Worker's *Logs* for the cron lines |
