// National Weather Service: official alerts and observed wind.
//
// The NWS alerts feed carries more than weather. Local officials relay
// non-weather emergencies through it too (Shelter In Place Warning,
// Hazardous Materials Warning, Civil Emergency Message, Evacuation Immediate,
// etc.), so it is the single most important source here.
import { COMPASS_POINTS, compass, distanceKm, round1 } from './geo.js';
import { TTLCache, getJson } from './http.js';

const API = 'https://api.weather.gov';
const GEOJSON = { Accept: 'application/geo+json' };

// Alerts that mean "protect yourself now" regardless of NWS severity field.
// Mirrored in app.js (NWS_ACTION_EVENTS) for the browser fallback.
export const ACTION_EVENTS = new Set([
    'Tornado Warning',
    'Extreme Wind Warning',
    'Shelter In Place Warning',
    'Evacuation Immediate',
    'Hazardous Materials Warning',
    'Civil Danger Warning',
    'Civil Emergency Message',
    'Local Area Emergency',
    'Nuclear Power Plant Warning',
    'Radiological Hazard Warning',
    'Fire Warning',
    'Law Enforcement Warning',
]);
// Flash Flood Emergencies arrive as "Flash Flood Warning" with severity
// "Extreme", which alertLevel() already treats as action.

export const caches = {
    alerts: new TTLCache(60_000),
    points: new TTLCache(24 * 3600_000),
    obs: new TTLCache(300_000),
};

const pt = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
const ORDER = { action: 0, warning: 1, advisory: 2, info: 3 };

export function alertLevel(p) {
    const event = p.event || '';
    const severity = p.severity || 'Unknown';
    if (ACTION_EVENTS.has(event) || severity === 'Extreme') return 'action';
    if (severity === 'Severe' || event.endsWith('Warning')) return 'warning';
    if (severity === 'Moderate' || event.endsWith('Watch') || event.endsWith('Advisory')) return 'advisory';
    return 'info';
}

export function normalizeAlert(feature) {
    const p = feature.properties || {};
    return {
        id: p.id || feature.id,
        event: p.event || 'Alert',
        headline: p.headline || p.event || '',
        description: (p.description || '').trim(),
        instruction: (p.instruction || '').trim(),
        severity: p.severity ?? null,
        urgency: p.urgency ?? null,
        certainty: p.certainty ?? null,
        response: p.response ?? null,
        sender: p.senderName ?? null,
        areas: p.areaDesc ?? null,
        effective: p.effective || p.sent || null,
        onset: p.onset ?? null,
        expires: p.expires ?? null,
        ends: p.ends ?? null,
        message_type: p.messageType ?? null,
        level: alertLevel(p),
        url: p['@id'] || feature.id || null,
        geometry: feature.geometry ?? null,
    };
}

export function fetchAlerts(lat, lon) {
    return caches.alerts.getOrFetch(pt(lat, lon), async () => {
        const data = await getJson(`${API}/alerts/active?point=${pt(lat, lon)}`, { headers: GEOJSON });
        return (data.features || [])
            .filter((f) => (f.properties?.status || 'Actual') === 'Actual')
            .map(normalizeAlert)
            .sort((a, b) => ORDER[a.level] - ORDER[b.level] || String(a.effective).localeCompare(String(b.effective)));
    });
}

function pointMeta(lat, lon) {
    return caches.points.getOrFetch(pt(lat, lon), async () => {
        const p = (await getJson(`${API}/points/${pt(lat, lon)}`, { headers: GEOJSON })).properties;
        const stations = (await getJson(p.observationStations, { headers: GEOJSON })).features || [];
        const rel = p.relativeLocation?.properties || {};
        return {
            forecastHourly: p.forecastHourly,
            place: [rel.city, rel.state].filter(Boolean).join(', '),
            // NWS doesn't promise distance order, so pick the nearest three ourselves.
            stations: stations
                .map((s) => ({
                    id: s.properties.stationIdentifier,
                    name: s.properties.name,
                    lat: s.geometry.coordinates[1],
                    lon: s.geometry.coordinates[0],
                }))
                .sort((a, b) => distanceKm(lat, lon, a.lat, a.lon) - distanceKm(lat, lon, b.lat, b.lon))
                .slice(0, 3),
        };
    });
}

const val = (obs, key) => obs?.[key]?.value ?? null;

/** Normalize an NWS observation's properties. Units: NWS sends km/h and degC. */
export function parseObservation(obs, station) {
    const windKmh = val(obs, 'windSpeed');
    const gustKmh = val(obs, 'windGust');
    const tempC = val(obs, 'temperature');
    const windDir = val(obs, 'windDirection');
    const rh = val(obs, 'relativeHumidity');
    return {
        source: 'observed',
        station: station.id ?? null,
        station_name: station.name ?? null,
        station_lat: station.lat ?? null,
        station_lon: station.lon ?? null,
        observed_at: obs.timestamp ?? null,
        description: obs.textDescription ?? null,
        wind_from_deg: windDir,
        wind_from: compass(windDir),
        wind_kmh: windKmh,
        wind_mph: windKmh == null ? null : Math.round(windKmh * 0.621371),
        gust_mph: gustKmh == null ? null : Math.round(gustKmh * 0.621371),
        temp_f: tempC == null ? null : Math.round((tempC * 9) / 5 + 32),
        humidity: rh == null ? null : Math.round(rh),
    };
}

/** Latest observed conditions from the nearest station with fresh wind data. */
export function fetchWeather(lat, lon, now = Date.now()) {
    return caches.obs.getOrFetch(pt(lat, lon), async () => {
        const meta = await pointMeta(lat, lon);
        for (const station of meta.stations) {
            let obs;
            try {
                obs = (await getJson(`${API}/stations/${station.id}/observations/latest`, { headers: GEOJSON })).properties;
            } catch {
                continue;
            }
            const ts = Date.parse(obs.timestamp || '');
            if (!Number.isFinite(ts) || now - ts > 3 * 3600_000) continue;
            const w = parseObservation(obs, station);
            if (w.wind_kmh == null && w.wind_from_deg == null) continue;
            w.place = meta.place;
            w.distance_km = round1(distanceKm(lat, lon, station.lat, station.lon));
            return w;
        }
        return forecastFallback(meta);
    });
}

/** If no station has a fresh reading, use the current hour of the forecast. */
async function forecastFallback(meta) {
    const period = (await getJson(meta.forecastHourly, { headers: GEOJSON })).properties.periods[0];
    const mph = parseInt(String(period.windSpeed || ''), 10);
    const direction = period.windDirection || null;
    const idx = COMPASS_POINTS.indexOf(direction);
    return {
        source: 'forecast',
        station: null,
        observed_at: period.startTime ?? null,
        description: period.shortForecast ?? null,
        wind_from_deg: idx >= 0 ? idx * 22.5 : null,
        wind_from: direction,
        wind_kmh: Number.isFinite(mph) ? mph / 0.621371 : null,
        wind_mph: Number.isFinite(mph) ? mph : null,
        gust_mph: null,
        temp_f: period.temperature ?? null,
        humidity: period.relativeHumidity?.value ?? null,
        place: meta.place,
    };
}
