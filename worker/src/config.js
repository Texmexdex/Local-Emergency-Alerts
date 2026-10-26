// Default "home" location: Highlands, TX (town centre; east Harris County, near Baytown).
// Every request can override this with ?lat=&lon=; the monitor reads HOME_* vars.
export const DEFAULT_LAT = 29.8188;
export const DEFAULT_LON = -95.0563;
export const DEFAULT_LABEL = 'Highlands, TX';
export const DEFAULT_RADIUS_KM = 16; // ~10 miles

// NWS requires a descriptive User-Agent with contact info.
export const USER_AGENT = 'LocalEmergencyAlerts/2.0 (+https://github.com/texmexdex/local-emergency-alerts)';

// Feed timestamps (CAER postings, Houston call times) are local Houston time.
export const LOCAL_TZ = 'America/Chicago';

export const HTTP_TIMEOUT_MS = 12000;
