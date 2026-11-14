// Local Emergency Alerts — frontend
// Talks to the Cloudflare Worker (worker/) for the combined assessment. If it
// is slow or unreachable, it falls back to the NWS API directly so official
// alerts are never blocked on it.

const params = new URLSearchParams(location.search);
const API_BASE = (params.get('api') ||
    (['localhost', '127.0.0.1'].includes(location.hostname)
        ? 'http://127.0.0.1:8787/api' // `npm run dev` in worker/
        : window.LEA_CONFIG?.apiBase) || '').replace(/\/+$/, '');
const NWS = 'https://api.weather.gov';
const REFRESH_MS = 60 * 1000;
const SLOW_BACKEND_MS = 7000;
const DEFAULT_LOCATION = { lat: 29.8188, lon: -95.0563, label: 'Highlands, TX' };

const LEVELS = ['clear', 'info', 'advisory', 'warning', 'action'];
const LEVEL_TEXT = { action: 'Act now', warning: 'Warning', advisory: 'Advisory', info: 'Routine', clear: 'All clear' };
const KIND_TEXT = { drill: 'Drill', all_clear: 'All clear', notice: 'Routine notice', incident: 'Incident', protective_action: 'Shelter / evacuate' };
const ICONS = { action: '!', warning: '!', advisory: 'i', clear: '✓', loading: '…' };
// Mirrors ACTION_EVENTS in worker/src/nws.js
const NWS_ACTION_EVENTS = new Set([
    'Tornado Warning', 'Extreme Wind Warning', 'Shelter In Place Warning', 'Evacuation Immediate',
    'Hazardous Materials Warning', 'Civil Danger Warning', 'Civil Emergency Message', 'Local Area Emergency',
    'Nuclear Power Plant Warning', 'Radiological Hazard Warning', 'Fire Warning', 'Law Enforcement Warning',
]);
const SOURCE_NAMES = {
    nws_alerts: 'National Weather Service alerts',
    weather: 'NWS observed wind & weather',
    caer: 'CAER industrial community notifications',
    houston_fire: 'City of Houston Fire/EMS active incidents',
    police: 'City of Houston Police active incidents',
    traffic: 'Houston TranStar traffic incidents',
    community: 'Scanner reports & official texts (phone relay)',
};
const CAER_APP_URL = 'https://www.ehcma.org/page/caer-online';
const SOURCE_LINKS = {
    caer: 'https://www.incident-reporter.net/e-notifycaerfeed/caermessagelive.html',
    houston_fire: 'https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx',
    police: 'https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx?agency=P',
    traffic: 'https://traffic.houstontranstar.org/roadclosures/',
    nws_alerts: 'https://www.weather.gov/hgx/',
};
const DOWNWIND_HALF_ANGLE = 30, DOWNWIND_MAX_KM = 25, CALM_KMH = 5, CALM_RADIUS_KM = 5;

// ---------- storage (best effort; the page works without it) ----------
function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

const settings = Object.assign(
    { ...DEFAULT_LOCATION, radiusMi: 10, notify: false, sound: false, minLevel: 'warning', showRoutine: false, showAllFire: false, showAllIncidents: false, hiddenLayers: [] },
    load('lea.settings', {}),
);
if (params.get('lat') && params.get('lon')) {
    settings.lat = parseFloat(params.get('lat'));
    settings.lon = parseFloat(params.get('lon'));
    settings.label = params.get('label') || `${settings.lat.toFixed(4)}, ${settings.lon.toFixed(4)}`;
}
const seen = load('lea.seen', {});

let lastStatus = null;
let firstLoad = true;
let inflight = false;
let audioCtx = null;

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c == null || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}
const rank = (lvl) => LEVELS.indexOf(lvl);
const kmToMi = (km) => (km == null ? null : Math.round(km * 0.621371 * 10) / 10);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function ago(iso) {
    const t = new Date(iso).getTime();
    if (!iso || Number.isNaN(t)) return '';
    const s = (Date.now() - t) / 1000;
    const f = (x) => (x < 90 ? 'just now' : x < 3600 ? `${Math.round(x / 60)} min` : x < 172800 ? `${Math.round(x / 3600)} hr` : `${Math.round(x / 86400)} days`);
    if (s < 0) return `in ${f(-s)}`;
    const r = f(s);
    return r === 'just now' ? r : `${r} ago`;
}
function clock(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function when(iso) { return iso ? `${clock(iso)} (${ago(iso)})` : 'time unknown'; }
function truncate(s, n) { return s && s.length > n ? `${s.slice(0, n).trimEnd()}…` : s || ''; }
function badge(level, text) { return el('span', { class: `badge lvl-${level}`, text: text || LEVEL_TEXT[level] }); }

function toRad(d) { return (d * Math.PI) / 180; }
function distanceKm(a, b, c, d) {
    const p1 = toRad(a), p2 = toRad(c), dp = p2 - p1, dl = toRad(d - b);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}
function destination(lat, lon, bearing, km) {
    const d = km / 6371.0088, b = toRad(bearing), p1 = toRad(lat), l1 = toRad(lon);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [(p2 * 180) / Math.PI, (l2 * 180) / Math.PI];
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => (deg == null ? null : COMPASS[Math.round((deg % 360) / 22.5) % 16]);

async function fetchJSON(url, { timeout = 20000, headers } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const r = await fetch(url, { signal: ctrl.signal, headers, cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } finally {
        clearTimeout(timer);
    }
}

// ---------- map ----------
let map, homeLayer, coneLayer, alertLayer, caerLayer, fireLayer, policeLayer, trafficLayer, scannerLayer;
const markerById = {};

function initMap() {
    map = L.map('map', { zoomControl: true }).setView([settings.lat, settings.lon], 11);
    // OpenStreetMap's own tiles need no API key (CARTO's now do). Dark mode
    // darkens them with a CSS filter on the tile pane (see style.css).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
    }).addTo(map);
    alertLayer = L.layerGroup().addTo(map);
    coneLayer = L.layerGroup().addTo(map);
    homeLayer = L.layerGroup().addTo(map);
    fireLayer = L.layerGroup();
    policeLayer = L.layerGroup();
    trafficLayer = L.layerGroup();
    scannerLayer = L.layerGroup();
    caerLayer = L.layerGroup();
    // Layer switches (top right). Hidden layers are remembered per browser.
    const overlays = {
        'Weather alert areas': alertLayer, 'Road incidents': trafficLayer, 'Police calls': policeLayer,
        'Fire / EMS calls': fireLayer, 'Scanner reports & texts': scannerLayer, 'Industrial (CAER)': caerLayer,
    };
    for (const [name, layer] of Object.entries(overlays)) {
        if (!settings.hiddenLayers.includes(name)) layer.addTo(map);
    }
    L.control.layers(null, overlays, { collapsed: true, position: 'topright' }).addTo(map);
    const remember = (hidden) => (e) => {
        settings.hiddenLayers = settings.hiddenLayers.filter((n) => n !== e.name);
        if (hidden) settings.hiddenLayers.push(e.name);
        save('lea.settings', settings);
    };
    map.on('overlayremove', remember(true));
    map.on('overlayadd', remember(false));
    drawHome(true);
}

function levelColor(level) {
    return cssVar(`--${level === 'clear' ? 'info' : level}`) || '#888';
}

function drawHome(fit) {
    homeLayer.clearLayers();
    const radiusM = settings.radiusMi / 0.621371 * 1000;
    const circle = L.circle([settings.lat, settings.lon], {
        radius: radiusM, color: cssVar('--home'), weight: 1.5, fillOpacity: 0.04, dashArray: '6 6', interactive: false,
    }).addTo(homeLayer);
    L.circleMarker([settings.lat, settings.lon], {
        radius: 8, color: '#fff', weight: 2, fillColor: cssVar('--home'), fillOpacity: 1,
    }).bindTooltip(settings.label).addTo(homeLayer);
    if (fit) map.fitBounds(circle.getBounds(), { padding: [10, 10] });
}

function popupFor(title, lines) {
    return el('div', {}, el('strong', { text: title }), ...lines.filter(Boolean).map((l) => el('div', { text: l })));
}

function drawMap(status) {
    caerLayer.clearLayers();
    fireLayer.clearLayers();
    policeLayer.clearLayers();
    trafficLayer.clearLayers();
    scannerLayer.clearLayers();
    coneLayer.clearLayers();
    alertLayer.clearLayers();
    for (const k of Object.keys(markerById)) delete markerById[k];

    for (const a of status.alerts || []) {
        if (!a.geometry) continue;
        L.geoJSON(a.geometry, {
            style: { color: levelColor(a.level), weight: 2, fillOpacity: 0.08 },
        }).bindPopup(popupFor(a.event, [a.headline])).addTo(alertLayer);
    }

    const w = status.weather;
    for (const p of visibleCaer(status)) {
        if (p.lat == null) continue;
        const color = levelColor(p.level);
        const m = L.circleMarker([p.lat, p.lon], {
            radius: p.level === 'info' ? 6 : 9,
            color, weight: 2.5,
            fillColor: color,
            fillOpacity: p.location_approximate ? 0.15 : 0.85,
        }).bindPopup(popupFor(p.facility, [
            `${KIND_TEXT[p.kind] || p.kind} · ${p.label}`,
            when(p.posted_at),
            p.distance_km != null ? `${kmToMi(p.distance_km)} mi ${p.bearing_from_home || ''} of you${p.location_approximate ? ' (approx. location)' : ''}` : null,
            truncate(p.text, 260),
        ])).addTo(caerLayer);
        markerById[p.id] = m;

        if (w && p.level !== 'info' && isCurrent(p)) drawCone(p, w, color);
    }

    for (const f of visibleFire(status)) {
        if (f.lat == null) continue;
        const color = levelColor(f.level);
        const m = L.circleMarker([f.lat, f.lon], {
            radius: f.level === 'info' ? 5 : 8, color, weight: 2, fillColor: color,
            fillOpacity: f.location_approximate ? 0.15 : 0.7,
        }).bindPopup(popupFor(`Houston Fire: ${f.type}`, [
            [f.address, f.cross_street].filter(Boolean).join(' & '),
            when(f.called_at),
            f.distance_km != null ? `${kmToMi(f.distance_km)} mi ${f.bearing_from_home || ''} of you` : null,
            f.location_source === 'keymap' ? `Approximate: centre of Key Map square ${f.key_map} (about ¾ mile across)` : null,
        ])).addTo(fireLayer);
        markerById[f.id] = m;
    }

    // Police calls and road incidents: routine ones in their own colour so they
    // don't read as emergencies; anything that raises the verdict uses its level colour.
    for (const i of visibleIncidents(status)) {
        if (i.lat == null) continue;
        const police = i.source === 'police';
        const color = i.level === 'info' ? cssVar(police ? '--police' : '--traffic') : levelColor(i.level);
        const m = L.circleMarker([i.lat, i.lon], {
            radius: i.level === 'info' ? 5 : 8, color, weight: 2, fillColor: color,
            fillOpacity: i.location_approximate ? 0.15 : 0.75,
        }).bindPopup(popupFor(police ? `Houston Police: ${i.type}` : `Road incident: ${i.type}`, [
            incidentPlace(i),
            when(i.time),
            i.lanes ? `Lanes affected: ${i.lanes}` : null,
            i.distance_km != null ? `${kmToMi(i.distance_km)} mi ${i.bearing_from_home || ''} of you` : null,
            i.location_source === 'keymap' ? `Approximate: centre of Key Map square ${i.key_map} (about ¾ mile across)` : null,
        ])).addTo(police ? policeLayer : trafficLayer);
        markerById[i.id] = m;
    }

    for (const c of status.community || []) {
        if (c.lat == null) continue;
        const color = c.level === 'info' ? cssVar('--scanner') : levelColor(c.level);
        const m = L.circleMarker([c.lat, c.lon], {
            radius: c.level === 'info' ? 6 : 9, color, weight: 2, fillColor: color,
            fillOpacity: c.location_approximate ? 0.15 : 0.75, dashArray: c.unconfirmed ? '3 3' : null,
        }).bindPopup(popupFor(reportTitle(c), [
            c.text,
            when(c.reported_at),
            c.distance_km != null ? `${kmToMi(c.distance_km)} mi ${c.bearing_from_home || ''} of you` : null,
            c.location_approximate ? `Approximate: centre of ${c.place}` : null,
            c.unconfirmed ? 'Unconfirmed: AI summary of dispatch radio. Details may be wrong.' : null,
        ])).addTo(scannerLayer);
        markerById[c.id] = m;
    }
    updateWindBadge(w);
}

function drawCone(p, w, color) {
    if (w.wind_kmh != null && w.wind_kmh < CALM_KMH) {
        L.circle([p.lat, p.lon], { radius: CALM_RADIUS_KM * 1000, color, weight: 0, fillOpacity: 0.18, interactive: false }).addTo(coneLayer);
        return;
    }
    if (w.wind_from_deg == null) return;
    const toward = (w.wind_from_deg + 180) % 360;
    const pts = [[p.lat, p.lon]];
    for (let b = toward - DOWNWIND_HALF_ANGLE; b <= toward + DOWNWIND_HALF_ANGLE; b += 5) {
        pts.push(destination(p.lat, p.lon, b, DOWNWIND_MAX_KM));
    }
    L.polygon(pts, { color, weight: 0, fillOpacity: 0.18, interactive: false }).addTo(coneLayer);
}

function updateWindBadge(w) {
    const box = $('wind-badge');
    if (!w || w.wind_from_deg == null) { box.hidden = true; return; }
    box.hidden = false;
    $('wind-arrow').style.transform = `rotate(${(w.wind_from_deg + 180) % 360}deg)`;
    $('wind-badge-text').textContent = `${w.wind_mph ?? '?'} mph from ${w.wind_from}`;
}

function focusOn(id) {
    const m = markerById[id];
    if (!m) return;
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 13));
    m.openPopup();
    $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- data ----------
function nwsLevel(p) {
    if (NWS_ACTION_EVENTS.has(p.event) || p.severity === 'Extreme') return 'action';
    if (p.severity === 'Severe' || /Warning$/.test(p.event || '')) return 'warning';
    if (p.severity === 'Moderate' || /(Watch|Advisory)$/.test(p.event || '')) return 'advisory';
    return 'info';
}

async function nwsDirect() {
    const pt = `${settings.lat.toFixed(4)},${settings.lon.toFixed(4)}`;
    const headers = { Accept: 'application/geo+json' };
    const out = { alerts: null, weather: null, errors: {} };
    const alertsP = fetchJSON(`${NWS}/alerts/active?point=${pt}`, { headers }).then((d) => {
        out.alerts = (d.features || [])
            .filter((f) => (f.properties.status || 'Actual') === 'Actual')
            .map((f) => {
                const p = f.properties;
                return {
                    id: p.id || f.id, event: p.event, headline: p.headline || p.event, description: p.description || '',
                    instruction: p.instruction || '', severity: p.severity, sender: p.senderName, areas: p.areaDesc,
                    effective: p.effective || p.sent, expires: p.expires, ends: p.ends, level: nwsLevel(p),
                    url: p['@id'] || f.id, geometry: f.geometry,
                };
            })
            .sort((a, b) => rank(b.level) - rank(a.level));
    }).catch((e) => { out.errors.nws_alerts = String(e); });

    const weatherP = (async () => {
        const meta = await fetchJSON(`${NWS}/points/${pt}`, { headers });
        const stations = await fetchJSON(meta.properties.observationStations, { headers });
        for (const s of (stations.features || []).slice(0, 3)) {
            try {
                const o = (await fetchJSON(`${NWS}/stations/${s.properties.stationIdentifier}/observations/latest`, { headers })).properties;
                if (Date.now() - new Date(o.timestamp).getTime() > 3 * 3600e3) continue;
                const dir = o.windDirection?.value, kmh = o.windSpeed?.value;
                if (dir == null && kmh == null) continue;
                const c = o.temperature?.value;
                const rel = meta.properties.relativeLocation?.properties || {};
                out.weather = {
                    source: 'observed', station: s.properties.stationIdentifier, station_name: s.properties.name,
                    observed_at: o.timestamp, description: o.textDescription, wind_from_deg: dir ?? null,
                    wind_from: compass(dir), wind_kmh: kmh ?? null, wind_mph: kmh == null ? null : Math.round(kmh * 0.621371),
                    gust_mph: o.windGust?.value == null ? null : Math.round(o.windGust.value * 0.621371),
                    temp_f: c == null ? null : Math.round(c * 9 / 5 + 32),
                    humidity: o.relativeHumidity?.value == null ? null : Math.round(o.relativeHumidity.value),
                    place: [rel.city, rel.state].filter(Boolean).join(', '),
                    distance_km: distanceKm(settings.lat, settings.lon, s.geometry.coordinates[1], s.geometry.coordinates[0]),
                };
                return;
            } catch { /* try next station */ }
        }
        throw new Error('no recent observation');
    })().catch((e) => { out.errors.weather = String(e); });

    await Promise.all([alertsP, weatherP]);
    return out;
}

// Build the same shape the API returns, from NWS data only.
function fallbackStatus(nws, pending, backendError) {
    const reasons = (nws.alerts || []).filter((a) => a.level !== 'info').map((a) => ({
        id: `nws-${a.id}`, level: a.level, source: 'NWS', title: a.event, detail: a.headline,
        instruction: a.instruction, time: a.effective, expires: a.ends || a.expires, distance_mi: null, url: a.url,
    }));
    const sources = {
        nws_alerts: { ok: !nws.errors.nws_alerts, error: nws.errors.nws_alerts || null },
        weather: { ok: !nws.errors.weather, error: nws.errors.weather || null },
        caer: { ok: false, pending, error: backendError },
        houston_fire: { ok: false, pending, error: backendError },
        police: { ok: false, pending, error: backendError, core: false },
        traffic: { ok: false, pending, error: backendError, core: false },
        community: { ok: false, pending, error: backendError, core: false },
    };
    const failed = Object.entries(sources).filter(([, s]) => !s.ok && !s.pending && s.core !== false).map(([k]) => SOURCE_NAMES[k]);
    const level = reasons.length ? reasons.reduce((m, r) => (rank(r.level) > rank(m) ? r.level : m), 'clear') : 'clear';
    return {
        generated_at: new Date().toISOString(),
        location: { lat: settings.lat, lon: settings.lon, label: settings.label },
        radius_mi: settings.radiusMi,
        level,
        headline: level === 'clear' ? 'No official alerts for your location' : null,
        reasons,
        downwind_of: [],
        complete: false,
        pending,
        failed_sources: failed,
        sources,
        alerts: nws.alerts || [],
        weather: nws.weather,
        caer: [],
        fire: [],
        police: [],
        traffic: [],
        community: [],
    };
}

async function refresh() {
    if (inflight) return;
    inflight = true;
    $('refresh-btn').disabled = true;
    $('checked-at').textContent = 'Checking…';
    const q = new URLSearchParams({ lat: settings.lat, lon: settings.lon, radius_mi: settings.radiusMi, label: settings.label });
    let settled = false;
    const slow = setTimeout(async () => {
        if (settled) return;
        $('checked-at').textContent = 'Still loading…';
        const nws = await nwsDirect();
        if (!settled) render(fallbackStatus(nws, true, null));
    }, SLOW_BACKEND_MS);
    try {
        if (!API_BASE) throw new Error('not configured: set apiBase in config.js');
        const status = await fetchJSON(`${API_BASE}/status?${q}`, { timeout: 45000 });
        settled = true;
        render(status);
    } catch (err) {
        settled = true;
        const nws = await nwsDirect();
        render(fallbackStatus(nws, false, `Data server unreachable (${err.name === 'AbortError' ? 'timed out' : err.message})`));
    } finally {
        clearTimeout(slow);
        inflight = false;
        $('refresh-btn').disabled = false;
    }
}

let aqiCache = { key: null, at: 0, data: null };
async function fetchAqi() {
    const key = `${settings.lat.toFixed(3)},${settings.lon.toFixed(3)}`;
    if (aqiCache.key === key && Date.now() - aqiCache.at < 10 * 60e3) return aqiCache.data;
    try {
        const d = await fetchJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${settings.lat}&longitude=${settings.lon}&current=us_aqi,pm2_5,ozone&timezone=auto`);
        aqiCache = { key, at: Date.now(), data: d.current };
    } catch {
        aqiCache = { key, at: Date.now(), data: null };
    }
    return aqiCache.data;
}

// ---------- rendering ----------
function isCurrent(p) { return p.age_hours != null && p.age_hours <= 24; }

function visibleCaer(status) {
    const all = status.caer || [];
    return settings.showRoutine ? all : all.filter((p) => p.level !== 'info' && isCurrent(p));
}
function visibleFire(status) {
    const all = status.fire || [];
    if (settings.showAllFire) return all;
    const r = settings.radiusMi / 0.621371;
    return all.filter((f) => f.distance_km != null && f.distance_km <= r && (f.level !== 'info' || ['fire', 'major_fire', 'hazmat'].includes(f.kind)));
}

/** Police calls and road incidents as one list: within the radius, or region-wide. */
function allIncidents(status) {
    const police = (status.police || []).map((p) => ({
        ...p, source: 'police', time: p.called_at, time_raw: p.call_time_raw,
    }));
    const traffic = (status.traffic || []).map((t) => ({ ...t, source: 'traffic', time: t.reported_at }));
    return [...police, ...traffic].sort((a, b) => rank(b.level) - rank(a.level)
        || (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9));
}
function visibleIncidents(status) {
    const all = allIncidents(status);
    if (settings.showAllIncidents) return all;
    const r = settings.radiusMi / 0.621371;
    return all.filter((i) => i.distance_km != null && i.distance_km <= r);
}
function incidentPlace(i) {
    if (i.source === 'traffic') return [i.location, i.direction && !i.location?.includes(i.direction) ? i.direction : null].filter(Boolean).join(' · ');
    return [i.address, i.cross_street].filter(Boolean).join(' & ');
}

function render(status) {
    lastStatus = status;
    drawMap(status);
    renderStatus(status);
    renderConditions(status.weather);
    renderNws(status);
    renderCaer(status);
    renderFire(status);
    renderIncidents(status);
    renderReports(status);
    handleNotifications(status);
    $('checked-at').textContent = `Checked ${new Date(status.generated_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    $('location-label').textContent = settings.label;
    const n = status.reasons.length;
    document.title = status.level === 'clear' ? 'Local Emergency Alerts' : `(${n}) ${LEVEL_TEXT[status.level].toUpperCase()} · Local Emergency Alerts`;
    // Items already showing when the page opens aren't "new"; only notify for later changes.
    if (!status.pending) firstLoad = false;
}

const GUIDANCE = {
    action: ['If you are told to shelter in place', [
        'Go indoors right away and stay there. Bring pets inside.',
        'Close and lock all windows and outside doors.',
        'Turn off air conditioning, heating and fans; close fireplace dampers.',
        'Go to an interior room with few windows, ideally above ground level.',
        'If instructed, seal gaps under doors and around windows with wet towels or plastic and tape.',
        'Keep your phone with you and follow Ready Harris, local TV/radio, or officials for updates.',
        'Stay inside until officials announce the all clear. If told to evacuate, leave by the route they give.',
        'Trouble breathing or other symptoms? Call 911.',
    ]],
    warning: ['Stay alert', [
        'Watch for official instructions (Ready Harris, NWS, local news).',
        'Be ready to go indoors quickly. If you smell chemicals or see smoke, go inside, close windows and turn off the A/C.',
        'Avoid the area around the incident and keep roads clear for responders.',
        'Call 911 only for emergencies, not for information.',
    ]],
};

function renderStatus(s) {
    const box = $('status');
    box.className = `status status-${s.level}`;
    $('status-icon').textContent = ICONS[s.level] || '…';
    $('status-headline').textContent = s.headline || {
        action: 'Take protective action now', warning: 'Emergency activity near you',
        advisory: 'Be aware: activity near you', clear: 'No active emergencies found near you',
    }[s.level];
    const sub = [`Within ${s.radius_mi ?? settings.radiusMi} mi of ${s.location?.label || settings.label}`];
    if (s.downwind_of?.length) sub.push(`You are downwind of ${s.downwind_of.join(', ')}`);
    $('status-sub').textContent = sub.join(' · ');

    const notice = $('status-notice');
    notice.replaceChildren();
    if (s.pending) {
        notice.append('Showing official NWS alerts while the industrial and fire feeds finish loading.');
    } else if (!API_BASE) {
        notice.append(
            el('strong', { text: 'Industrial and fire feeds are not connected yet. ' }),
            'Official NWS alerts and wind are shown. To add CAER and Houston Fire data, set the data server URL (apiBase) in config.js. ',
            ...['caer', 'houston_fire'].flatMap((k, i) => [i ? ' · ' : '', el('a', { href: SOURCE_LINKS[k], target: '_blank', rel: 'noopener', text: SOURCE_NAMES[k] })]),
        );
    } else if (!s.complete && s.failed_sources?.length) {
        const caerGone = Boolean(s.sources?.caer?.unavailable);
        const failedKeys = Object.keys(SOURCE_LINKS).filter((k) => s.sources?.[k] && !s.sources[k].ok
            && s.sources[k].core !== false && !(k === 'caer' && caerGone));
        if (failedKeys.length) {
            notice.append(
                el('strong', { text: 'This may not be the full picture. ' }),
                `Couldn't get data from: ${failedKeys.map((k) => SOURCE_NAMES[k]).join('; ')}. `,
                'Check those sources directly: ',
                ...failedKeys.flatMap((k, i) => [i ? ', ' : '', el('a', { href: SOURCE_LINKS[k], target: '_blank', rel: 'noopener', text: SOURCE_NAMES[k] })]),
            );
        }
        if (caerGone) {
            if (failedKeys.length) notice.append(el('br'));
            notice.append(
                el('strong', { text: 'Plant (CAER) notifications are not included. ' }),
                'EHCMA no longer publishes them on the public web; they are in the ',
                el('a', { href: CAER_APP_URL, target: '_blank', rel: 'noopener', text: 'EHCMA CAER Online app' }),
                '. Official shelter-in-place and hazmat orders still come through the NWS alerts here.',
            );
        }
    }
    notice.hidden = !notice.childNodes.length;

    $('reasons').replaceChildren(...s.reasons.map((r) => el('li', { class: `reason lvl-${r.level}` },
        el('p', { class: 'reason-title' }, badge(r.level), ' ', el('span', { class: 'badge', text: r.source }), ' ', r.title),
        el('p', { class: 'reason-meta' },
            r.distance_mi != null ? el('span', { text: `${r.distance_mi} mi ${r.direction || ''} of you` }) : null,
            r.time ? el('span', { text: `Posted ${when(r.time)}` }) : null,
            r.expires ? el('span', { text: `Until ${clock(r.expires)}` }) : null,
            r.url ? el('a', { href: r.url, target: '_blank', rel: 'noopener', text: 'Source' }) : null,
            markerById[r.id]
                ? el('a', { href: '#map', text: 'Show on map', onclick: (e) => { e.preventDefault(); focusOn(r.id); } }) : null,
        ),
        r.detail ? longText(r.detail, 320) : null,
        r.note ? el('p', { class: 'reason-note', text: `⚠ ${r.note[0].toUpperCase()}${r.note.slice(1)}.` }) : null,
        r.instruction ? el('p', { class: 'reason-instruction', text: r.instruction }) : null,
    )));

    const g = GUIDANCE[s.level];
    const gbox = $('guidance');
    gbox.hidden = !g;
    if (g) gbox.replaceChildren(el('h3', { text: g[0] }), el(s.level === 'action' ? 'ol' : 'ul', {}, g[1].map((t) => el('li', { text: t }))));
}

function longText(text, n) {
    if (text.length <= n) return el('p', { class: 'item-text', text });
    return el('details', {}, el('summary', { class: 'item-text clip', text: truncate(text, n) }), el('p', { class: 'item-text', text }));
}

function unavailable(source, s) {
    const src = s.sources?.[source] || {};
    if (src.pending) return el('p', { class: 'muted', text: 'Loading…' });
    if (source === 'caer' && src.unavailable) {
        return el('div', { class: 'unavailable' },
            el('strong', { text: 'Not available on the public web. ' }),
            "Since Oct 20, 2026 the CAER message page requires a sign-in, so this tool can't read plant notifications. ",
            'For plant alerts (flaring, releases, shelter-in-place messages from facilities), install the ',
            el('a', { href: CAER_APP_URL, target: '_blank', rel: 'noopener', text: 'EHCMA CAER Online app' }),
            ' and turn on its notifications. This panel will fill in automatically if the public feed returns.');
    }
    return el('div', { class: 'unavailable' },
        'This feed is unavailable right now. ',
        el('a', { href: SOURCE_LINKS[source], target: '_blank', rel: 'noopener', text: 'Open the source directly' }), '.');
}

function renderNws(s) {
    const list = $('nws-list');
    if (!s.sources?.nws_alerts?.ok) { list.replaceChildren(unavailable('nws_alerts', s)); $('nws-count').textContent = ''; return; }
    $('nws-count').textContent = `${s.alerts.length} active`;
    if (!s.alerts.length) { list.replaceChildren(el('p', { class: 'empty', text: '✓ No active alerts for your location' })); return; }
    list.replaceChildren(...s.alerts.map((a) => el('div', { class: `item lvl-${a.level}` },
        el('p', { class: 'item-title' }, badge(a.level), ' ', a.event),
        el('p', { class: 'item-meta' },
            a.sender ? el('span', { text: a.sender }) : null,
            el('span', { text: `From ${clock(a.effective)}` }),
            a.ends || a.expires ? el('span', { text: `until ${clock(a.ends || a.expires)}` }) : null),
        el('p', { class: 'item-text', text: a.headline }),
        el('details', {}, el('summary', { text: 'Details & instructions' }),
            a.instruction ? el('p', {}, el('strong', { text: 'What to do: ' }), a.instruction) : null,
            el('p', { text: a.description }),
            a.areas ? el('p', { class: 'muted', text: `Areas: ${a.areas}` }) : null),
    )));
}

function renderCaer(s) {
    const list = $('caer-list');
    if (!s.sources?.caer?.ok) { list.replaceChildren(unavailable('caer', s)); $('caer-count').textContent = ''; return; }
    const all = s.caer;
    const active = all.filter((p) => p.level !== 'info' && isCurrent(p));
    const shown = visibleCaer(s);
    $('caer-count').textContent = `${active.length} active · ${all.length} posted`;
    const items = shown.map((p) => el('div', {
        class: `item lvl-${p.level}${p.lat != null ? ' clickable' : ''}`,
        onclick: p.lat != null ? (e) => { if (!e.target.closest('details,a')) focusOn(p.id); } : null,
    },
        el('p', { class: 'item-title' }, badge(p.level, p.level === 'info' ? KIND_TEXT[p.kind] : LEVEL_TEXT[p.level]), ' ', p.facility),
        el('p', { class: 'item-meta' },
            el('span', { text: p.label }),
            el('span', { text: when(p.posted_at) }),
            !isCurrent(p) ? el('span', { text: 'older than 24 hr' }) : null,
            p.distance_km != null
                ? el('span', { text: `${kmToMi(p.distance_km)} mi ${p.bearing_from_home || ''}${p.location_approximate ? ' (approx.)' : ''}` })
                : el('span', { text: 'location unknown' }),
            p.exposure === 'downwind' && p.level !== 'info' ? el('strong', { text: 'You are downwind' }) : null),
        longText(p.text, 300),
        p.updates?.length ? el('details', {}, el('summary', { text: `${p.updates.length} earlier update${p.updates.length > 1 ? 's' : ''}` }),
            ...p.updates.map((u) => el('p', {}, el('strong', { text: `${u.label || 'Update'} · ${clock(u.posted_at)}: ` }), u.text))) : null,
    ));
    if (!active.length && !settings.showRoutine) {
        items.unshift(el('p', { class: 'empty', text: `✓ No active industrial incidents. ${all.length} routine posting${all.length === 1 ? '' : 's'} (flaring, drills, all-clears) hidden.` }));
    }
    const meta = s.sources.caer.meta;
    if (meta?.via === 'relay') {
        items.unshift(el('p', { class: 'muted', text:
            `Relayed from your phone's CAER app · last check-in ${ago(meta.last_seen_at)}`
            + (meta.heartbeat ? '' : ' (no heartbeat set up, so a quiet phone looks the same as an offline one)') }));
    }
    list.replaceChildren(...items);
}

function renderFire(s) {
    const list = $('fire-list');
    if (!s.sources?.houston_fire?.ok) { list.replaceChildren(unavailable('houston_fire', s)); $('fire-count').textContent = ''; return; }
    const shown = visibleFire(s);
    const mapped = s.fire.filter((f) => f.lat != null).length;
    $('fire-count').textContent = `${s.fire.length} citywide · ${mapped} mapped`;
    if (!shown.length) {
        list.replaceChildren(el('p', { class: 'empty', text: `✓ No fire or hazmat calls within ${settings.radiusMi} mi in the City of Houston feed` }));
        return;
    }
    list.replaceChildren(...shown.map((f) => el('div', {
        class: `item lvl-${f.level}${f.lat != null ? ' clickable' : ''}`,
        onclick: f.lat != null ? () => focusOn(f.id) : null,
    },
        el('p', { class: 'item-title' }, f.level !== 'info' ? [badge(f.level), ' '] : null, f.type),
        el('p', { class: 'item-meta' },
            el('span', { text: [f.address, f.cross_street].filter(Boolean).join(' & ') || 'No address' }),
            el('span', { text: f.called_at ? when(f.called_at) : f.call_time_raw || '' }),
            el('span', { text: f.distance_km != null ? `${kmToMi(f.distance_km)} mi ${f.bearing_from_home || ''}${f.location_approximate ? ' (approx.)' : ''}` : 'not mapped' }),
            f.alarm ? el('span', { text: `Alarm ${f.alarm}` }) : null),
    )));
}

const INCIDENT_LIMIT = 40;
const KIND_LABEL = {
    crash: 'Crash', accident: 'Crash', hazard: 'Road hazard', stall: 'Stall', crime: 'Police', closure: 'Closure',
    hazmat: 'Hazmat', flooding: 'High water', fire: 'Fire', other: 'Police',
};

function renderIncidents(s) {
    const list = $('incident-list');
    const policeOk = s.sources?.police?.ok;
    const trafficOk = s.sources?.traffic?.ok;
    if (!policeOk && !trafficOk) {
        list.replaceChildren(s.sources?.police?.pending ? el('p', { class: 'muted', text: 'Loading…' })
            : el('div', { class: 'unavailable' }, 'Police and traffic feeds are unavailable right now. Open ',
                el('a', { href: SOURCE_LINKS.police, target: '_blank', rel: 'noopener', text: 'Houston Police' }), ' or ',
                el('a', { href: SOURCE_LINKS.traffic, target: '_blank', rel: 'noopener', text: 'TranStar' }), ' directly.'));
        $('incident-count').textContent = '';
        return;
    }
    const shown = visibleIncidents(s);
    const nPolice = shown.filter((i) => i.source === 'police').length;
    $('incident-count').textContent = `${nPolice} police · ${shown.length - nPolice} road`
        + (settings.showAllIncidents ? ' region-wide' : ` within ${settings.radiusMi} mi`);
    const notes = [];
    if (!policeOk) notes.push(el('p', { class: 'muted', text: 'Houston Police feed unavailable right now; showing road incidents only.' }));
    if (!trafficOk) notes.push(el('p', { class: 'muted', text: 'TranStar feed unavailable right now; showing police calls only.' }));
    if (!shown.length) {
        list.replaceChildren(...notes, el('p', { class: 'empty', text: `✓ No police calls or road incidents within ${settings.radiusMi} mi` }));
        return;
    }
    const items = shown.slice(0, INCIDENT_LIMIT).map((i) => el('div', {
        class: `item lvl-${i.level} src-${i.source}${i.lat != null ? ' clickable' : ''}`,
        onclick: i.lat != null ? () => focusOn(i.id) : null,
    },
        el('p', { class: 'item-title' },
            i.level !== 'info' ? badge(i.level) : el('span', { class: `badge src-${i.source}`, text: i.source === 'police' ? 'HPD' : 'Road' }),
            ' ', i.type),
        el('p', { class: 'item-meta' },
            el('span', { text: incidentPlace(i) || 'No location given' }),
            el('span', { text: i.time ? when(i.time) : i.time_raw || '' }),
            el('span', { text: i.distance_km != null ? `${kmToMi(i.distance_km)} mi ${i.bearing_from_home || ''}${i.location_approximate ? ' (approx.)' : ''}` : 'not mapped' }),
            i.lanes ? el('span', { text: `Lanes: ${i.lanes}` }) : null),
    ));
    if (shown.length > INCIDENT_LIMIT) {
        items.push(el('p', { class: 'muted', text: `+ ${shown.length - INCIDENT_LIMIT} more (nearest shown first; all are on the map)` }));
    }
    list.replaceChildren(...notes, ...items);
}

function reportTitle(c) {
    const head = c.title || ({ protective: 'Protective action', hazmat: 'Hazmat', major_fire: 'Major fire' }[c.category] || 'Report');
    return c.kind === 'scanner' ? `Scanner: ${head}` : `${c.app || 'Text'}: ${head}`;
}

function renderReports(s) {
    const list = $('report-list');
    const src = s.sources?.community;
    const reports = s.community || [];
    if (src?.pending) { list.replaceChildren(el('p', { class: 'muted', text: 'Loading…' })); $('report-count').textContent = ''; return; }
    if (!src?.ok) {
        list.replaceChildren(el('div', { class: 'unavailable' }, 'Not set up. Install the Alert Relay app (see DEPLOYMENT.md) and list CrimeRadar in its settings.'));
        $('report-count').textContent = '';
        return;
    }
    $('report-count').textContent = `${reports.length} in the last 24 h`;
    if (!reports.length) {
        const apps = src.meta?.apps?.length ? ` Apps forwarded so far: ${src.meta.apps.join(', ')}.` : ' Nothing has been forwarded yet from CrimeRadar or texts.';
        list.replaceChildren(el('p', { class: 'empty', text: `✓ No scanner reports or official texts in the last 24 hours.${apps}` }));
        return;
    }
    list.replaceChildren(...reports.slice(0, INCIDENT_LIMIT).map((c) => el('div', {
        class: `item lvl-${c.level} src-scanner${c.lat != null ? ' clickable' : ''}`,
        onclick: c.lat != null ? () => focusOn(c.id) : null,
    },
        el('p', { class: 'item-title' },
            c.level !== 'info' ? [badge(c.level), ' '] : null,
            el('span', { class: 'badge src-scanner', text: c.unconfirmed ? 'Scanner · unconfirmed' : (c.kind === 'sms' ? 'Text' : (c.app || 'Post')) }),
            ' ', c.title || c.category),
        c.text ? el('p', { class: 'item-text', text: truncate(c.text, 300) }) : null,
        el('p', { class: 'item-meta' },
            el('span', { text: when(c.reported_at) }),
            el('span', { text: c.distance_km != null ? `${kmToMi(c.distance_km)} mi ${c.bearing_from_home || ''}${c.location_approximate ? ` (near ${c.place})` : ''}` : (c.place || 'not mapped') }),
            c.kind === 'sms' && c.app ? el('span', { text: `via ${c.app}` }) : null),
    )));
}

const AQI_BANDS = [[50, 'Good'], [100, 'Moderate'], [150, 'Unhealthy for sensitive groups'], [200, 'Unhealthy'], [300, 'Very unhealthy'], [Infinity, 'Hazardous']];

async function renderConditions(w) {
    const box = $('conditions');
    const metric = (label, value, sub) => el('div', { class: 'metric' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }), sub ? el('div', { class: 'sub', text: sub }) : null);
    const parts = [];
    if (w) {
        const toward = w.wind_from_deg == null ? null : compass((w.wind_from_deg + 180) % 360);
        parts.push(metric('Wind', w.wind_from ? `${w.wind_from} ${w.wind_mph ?? '?'} mph` : `${w.wind_mph ?? '?'} mph`,
            [toward ? `blowing toward the ${toward}` : null, w.gust_mph ? `gusts ${w.gust_mph} mph` : null].filter(Boolean).join(' · ')));
        parts.push(metric('Temperature', w.temp_f != null ? `${w.temp_f}°F` : '—', w.description || null));
        parts.push(metric('Humidity', w.humidity != null ? `${w.humidity}%` : '—'));
    }
    const aqi = await fetchAqi();
    if (aqi && aqi.us_aqi != null) {
        const band = AQI_BANDS.find(([max]) => aqi.us_aqi <= max)[1];
        parts.push(metric('Air quality (est.)', `AQI ${Math.round(aqi.us_aqi)}`, band));
    }
    if (!parts.length) { box.replaceChildren(el('p', { class: 'muted', text: 'Weather data unavailable.' })); return; }
    const src = w
        ? (w.source === 'observed'
            ? `Wind measured at ${w.station_name || w.station}${w.distance_km != null ? ` (${kmToMi(w.distance_km)} mi away)` : ''}, ${ago(w.observed_at)}.`
            : 'No fresh station reading; wind is from the current-hour NWS forecast.')
        : '';
    box.replaceChildren(...parts, el('p', { class: 'fineprint', text: `${src} Air quality is a regional model estimate (Open-Meteo) and will not detect a local chemical plume; see AirNow for official monitor readings.` }));
}

// ---------- notifications ----------
function handleNotifications(status) {
    const min = rank(settings.minLevel);
    let fresh = [];
    for (const r of status.reasons) {
        const prev = seen[r.id];
        if (prev === undefined || rank(r.level) > rank(prev)) {
            if (rank(r.level) >= min && !firstLoad) fresh.push(r);
            seen[r.id] = r.level;
        }
    }
    const keys = Object.keys(seen);
    if (keys.length > 400) keys.slice(0, keys.length - 400).forEach((k) => delete seen[k]);
    save('lea.seen', seen);
    if (!fresh.length) return;
    fresh = fresh.sort((a, b) => rank(b.level) - rank(a.level));
    if (settings.sound) playAlarm(fresh[0].level);
    if (settings.notify && 'Notification' in window && Notification.permission === 'granted') {
        for (const r of fresh.slice(0, 4)) {
            try {
                const n = new Notification(`${LEVEL_TEXT[r.level].toUpperCase()}: ${r.title}`, {
                    body: [r.distance_mi != null ? `${r.distance_mi} mi ${r.direction || ''} of you` : null, r.note, truncate(r.detail, 180)].filter(Boolean).join(' — '),
                    tag: r.id,
                    requireInteraction: r.level === 'action',
                });
                n.onclick = () => { window.focus(); n.close(); };
            } catch { /* some mobile browsers only allow notifications from a service worker */ }
        }
    }
}

function playAlarm(level) {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const beeps = level === 'action' ? 6 : level === 'warning' ? 3 : 1;
        for (let i = 0; i < beeps; i++) {
            const o = audioCtx.createOscillator(), g = audioCtx.createGain();
            const t = audioCtx.currentTime + i * 0.45;
            o.frequency.value = i % 2 ? 660 : 880;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
            o.connect(g).connect(audioCtx.destination);
            o.start(t);
            o.stop(t + 0.4);
        }
    } catch { /* audio not available */ }
}

// ---------- location dialog ----------
function setLocation(lat, lon, label) {
    Object.assign(settings, { lat, lon, label });
    save('lea.settings', settings);
    history.replaceState(null, '', location.pathname + (params.get('api') ? `?api=${encodeURIComponent(params.get('api'))}` : ''));
    $('location-label').textContent = label;
    drawHome(true);
    refresh();
}

async function searchLocation() {
    const q = $('location-input').value.trim();
    const out = $('geo-results');
    const err = $('location-error');
    err.hidden = true;
    if (q.length < 3) return;
    out.replaceChildren(el('li', { class: 'muted', text: 'Searching…' }));
    let results = [];
    try {
        if (!API_BASE) throw new Error('no data server');
        results = (await fetchJSON(`${API_BASE}/geocode?q=${encodeURIComponent(q)}`, { timeout: 25000 })).results || [];
    } catch { /* fall through to OpenStreetMap */ }
    if (!results.length) {
        try {
            const rows = await fetchJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`);
            results = rows.map((r) => ({ lat: parseFloat(r.lat), lon: parseFloat(r.lon), label: r.display_name }));
        } catch { /* nothing */ }
    }
    if (!results.length) {
        out.replaceChildren();
        err.textContent = 'No match found. Try a full street address with city and state.';
        err.hidden = false;
        return;
    }
    out.replaceChildren(...results.map((r) => el('li', {}, el('button', {
        type: 'button', text: r.label,
        onclick: () => { setLocation(r.lat, r.lon, shortLabel(r.label)); $('location-dialog').close(); },
    }))));
}

function shortLabel(label) {
    const parts = label.split(',').map((s) => s.trim());
    return parts.length > 3 ? parts.slice(0, 3).join(', ') : label;
}

function useGps() {
    const err = $('location-error');
    err.hidden = true;
    if (!navigator.geolocation) { err.textContent = 'Location is not available in this browser.'; err.hidden = false; return; }
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            setLocation(+pos.coords.latitude.toFixed(5), +pos.coords.longitude.toFixed(5), 'My location');
            $('location-dialog').close();
        },
        (e) => { err.textContent = `Couldn't get your location: ${e.message}`; err.hidden = false; },
        { enableHighAccuracy: false, timeout: 15000 },
    );
}

// ---------- wiring ----------
document.addEventListener('DOMContentLoaded', () => {
    initMap();

    $('radius-select').value = String(settings.radiusMi);
    $('notify-toggle').checked = settings.notify && 'Notification' in window && Notification.permission === 'granted';
    $('sound-toggle').checked = settings.sound;
    $('min-level-select').value = settings.minLevel;
    $('show-routine').checked = settings.showRoutine;
    $('show-all-fire').checked = settings.showAllFire;
    $('show-all-incidents').checked = settings.showAllIncidents;
    $('location-label').textContent = settings.label;

    $('refresh-btn').addEventListener('click', refresh);
    $('radius-select').addEventListener('change', (e) => {
        settings.radiusMi = parseFloat(e.target.value);
        save('lea.settings', settings);
        drawHome(true);
        refresh();
    });
    $('min-level-select').addEventListener('change', (e) => { settings.minLevel = e.target.value; save('lea.settings', settings); });
    $('notify-toggle').addEventListener('change', async (e) => {
        if (e.target.checked) {
            if (!('Notification' in window)) { e.target.checked = false; alert('This browser does not support notifications.'); return; }
            const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
            if (perm !== 'granted') { e.target.checked = false; alert('Notifications are blocked for this site. Enable them in your browser settings.'); return; }
        }
        settings.notify = e.target.checked;
        save('lea.settings', settings);
    });
    $('sound-toggle').addEventListener('change', (e) => {
        settings.sound = e.target.checked;
        save('lea.settings', settings);
        if (settings.sound) playAlarm('advisory'); // unlocks audio (needs a user gesture) and previews the sound
    });
    $('show-routine').addEventListener('change', (e) => {
        settings.showRoutine = e.target.checked; save('lea.settings', settings);
        if (lastStatus) { renderCaer(lastStatus); drawMap(lastStatus); }
    });
    $('show-all-fire').addEventListener('change', (e) => {
        settings.showAllFire = e.target.checked; save('lea.settings', settings);
        if (lastStatus) { renderFire(lastStatus); drawMap(lastStatus); }
    });
    $('show-all-incidents').addEventListener('change', (e) => {
        settings.showAllIncidents = e.target.checked; save('lea.settings', settings);
        if (lastStatus) { renderIncidents(lastStatus); drawMap(lastStatus); }
    });

    const dialog = $('location-dialog');
    $('location-btn').addEventListener('click', () => { $('geo-results').replaceChildren(); $('location-error').hidden = true; dialog.showModal(); $('location-input').focus(); });
    $('location-search').addEventListener('click', searchLocation);
    $('location-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchLocation(); } });
    $('use-gps').addEventListener('click', useGps);

    refresh();
    setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && lastStatus && Date.now() - new Date(lastStatus.generated_at).getTime() > REFRESH_MS) refresh();
    });
});
