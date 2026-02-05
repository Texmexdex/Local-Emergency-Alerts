// Configuration
const API_BASE_URL = 'https://texmexdex-local-emergency-alerts.hf.space/api';
const REFRESH_INTERVAL = 30000; // 30 seconds
const USE_MOCK_DATA = false; // Set to true for testing without backend

let map;
let markers = {};
let incidentMarkers = [];
let allIncidents = []; // Store all incidents for history
let allIncidentsUnfiltered = []; // Store ALL incidents including non-priority
let currentSort = 'time';
let showAllHistory = false;
let showAllIncidents = false;

// Radio scanner state
let radioFeeds = [];
let currentRadioFeed = null;
let autoSwitchEnabled = true;

// Plume & Facilities state
let facilities = [];
let plumeLayer = null;
let showPlumes = false;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    fetchAllData();

    // Auto-refresh
    setInterval(fetchAllData, REFRESH_INTERVAL);

    // Manual refresh button
    document.getElementById('refresh-btn').addEventListener('click', () => {
        fetchAllData();
    });

    // Sort controls
    document.querySelectorAll('.sort-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentSort = e.target.dataset.sort;
            renderDispatchTable();
        });
    });

    // Show all history toggle
    document.getElementById('show-all').addEventListener('change', (e) => {
        showAllHistory = e.target.checked;
        renderDispatchTable();
    });

    // Show all incidents toggle
    document.getElementById('show-all-incidents').addEventListener('change', (e) => {
        showAllIncidents = e.target.checked;
        renderDispatchTable();
        // Update map markers
        const data = showAllIncidents ?
            (showAllHistory ? allIncidentsUnfiltered : allIncidentsUnfiltered.slice(0, 100)) :
            (showAllHistory ? allIncidents : allIncidents.slice(0, 100));
        addIncidentMarkers(data);
    });

    // Radio channel selector
    document.getElementById('radio-channel').addEventListener('change', (e) => {
        const feedId = e.target.value;
        if (feedId) {
            switchRadioChannel(parseInt(feedId));
        }
    });

    // Auto-switch toggle
    document.getElementById('auto-switch').addEventListener('change', (e) => {
        autoSwitchEnabled = e.target.checked;
    });

    // Load radio feeds
    fetchRadioFeeds();

    // Plume toggle
    document.getElementById('show-plumes').addEventListener('change', (e) => {
        showPlumes = e.target.checked;
        // Redraw if we have wind data
        const windDir = document.getElementById('wind-dir-overlay').textContent;
        const isRisk = document.getElementById('wind-arrow').classList.contains('risk');
        if (windDir !== '---') {
            drawPlume(windDir, isRisk);
        }
    });
});

// Initialize Leaflet Map
function initMap() {
    map = L.map('map', {
        center: [29.78, -95.05],
        zoom: 11,
        zoomControl: true
    });

    // Dark tile layer
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(map);

    // Initialize plume layer
    plumeLayer = L.layerGroup().addTo(map);

    fetchFacilities();
}

// Fetch all data sources
async function fetchAllData() {
    updateTimestamp();
    await Promise.all([
        fetchWind(),
        fetchCAER(),
        fetchDispatch(),
        fetchWeatherAlerts(),
        fetchTCEQEmissions()
    ]);
}

// Update timestamp
function updateTimestamp() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
    document.getElementById('last-update').textContent = `LAST UPDATE: ${timeStr}`;
}

// Fetch Wind Data
async function fetchWind() {
    try {
        const response = await fetch(`${API_BASE_URL}/wind`);
        const data = await response.json();

        if (data.error) {
            throw new Error(data.error);
        }

        document.getElementById('wind-direction').textContent = data.direction;
        document.getElementById('wind-speed').textContent = data.speed;
        document.getElementById('temperature').textContent = `${data.temperature}°F`;

        // Update wind overlay on map
        updateWindOverlay(data.direction, data.speed, data.is_risk);

        const alertDiv = document.getElementById('wind-alert');
        if (data.is_risk) {
            alertDiv.className = 'wind-alert risk';
            alertDiv.textContent = `⚠ PLUME RISK: Wind from ${data.direction}. Industrial emissions may drift toward residential areas.`;
        } else {
            alertDiv.className = 'wind-alert clear';
            alertDiv.textContent = `✓ WIND CLEAR: Wind from ${data.direction}. Plumes dispersing away from residential zones.`;
        }

    } catch (error) {
        console.error('Wind fetch error:', error);
        document.getElementById('wind-direction').textContent = 'OFFLINE';
        document.getElementById('wind-speed').textContent = 'OFFLINE';
        document.getElementById('temperature').textContent = 'OFFLINE';

        const alertDiv = document.getElementById('wind-alert');
        alertDiv.className = 'wind-alert';
        alertDiv.textContent = 'METEOROLOGICAL DATA UNAVAILABLE';
    }
}

// Fetch CAER Messages
async function fetchCAER() {
    try {
        const response = await fetch(`${API_BASE_URL}/caer`);
        const data = await response.json();

        if (data.error) {
            throw new Error(data.error);
        }

        const container = document.getElementById('caer-messages');
        const countEl = document.getElementById('caer-count');

        countEl.textContent = `${data.count} ACTIVE MESSAGES`;

        if (data.messages.length === 0) {
            container.innerHTML = '<div class="loading">NO ACTIVE CAER MESSAGES</div>';
            return;
        }

        container.innerHTML = data.messages.map(msg => `
            <div class="caer-message ${msg.severity}">
                <div class="caer-message-title">${escapeHtml(msg.title)}</div>
                <div class="caer-message-body">${escapeHtml(msg.body)}</div>
            </div>
        `).join('');

    } catch (error) {
        console.error('CAER fetch error:', error);
        document.getElementById('caer-messages').innerHTML =
            '<div class="error">CAER FEED UNAVAILABLE</div>';
        document.getElementById('caer-count').textContent = '0 ACTIVE MESSAGES';
    }
}

// Fetch Dispatch Log
async function fetchDispatch() {
    try {
        const response = await fetch(`${API_BASE_URL}/dispatch`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        console.log('Dispatch data:', data); // Debug log

        if (data.error) {
            console.error('Dispatch API error:', data.error);
            throw new Error(data.error);
        }

        const countEl = document.getElementById('dispatch-count');
        countEl.textContent = `${data.priority_count || 0} PRIORITY INCIDENTS (${data.total_incidents || 0} TOTAL)`;

        if ((!data.incidents || data.incidents.length === 0) && (!data.all_incidents || data.all_incidents.length === 0)) {
            document.getElementById('dispatch-tbody').innerHTML =
                '<tr><td colspan="4" class="loading">NO INCIDENTS DETECTED</td></tr>';
            return;
        }

        // Merge new priority incidents with history
        if (data.incidents && Array.isArray(data.incidents)) {
            data.incidents.forEach(newInc => {
                const exists = allIncidents.some(inc =>
                    inc['Call Time'] === newInc['Call Time'] &&
                    inc['Address'] === newInc['Address']
                );
                if (!exists) {
                    allIncidents.unshift(newInc);
                }
            });
        }

        // Merge ALL incidents with unfiltered history
        if (data.all_incidents && Array.isArray(data.all_incidents)) {
            data.all_incidents.forEach(newInc => {
                const exists = allIncidentsUnfiltered.some(inc =>
                    inc['Call Time'] === newInc['Call Time'] &&
                    inc['Address'] === newInc['Address']
                );
                if (!exists) {
                    allIncidentsUnfiltered.unshift(newInc);
                }
            });
        }

        // Add incident markers to map
        const incidentsToMap = showAllIncidents ?
            (showAllHistory ? allIncidentsUnfiltered : (data.all_incidents || [])) :
            (showAllHistory ? allIncidents : (data.incidents || []));
        addIncidentMarkers(incidentsToMap);

        // Render table
        renderDispatchTable();

    } catch (error) {
        console.error('Dispatch fetch error:', error);
        document.getElementById('dispatch-tbody').innerHTML =
            `<tr><td colspan="4" class="error">DISPATCH FEED UNAVAILABLE: ${error.message}</td></tr>`;
        document.getElementById('dispatch-count').textContent = '0 PRIORITY INCIDENTS';
    }
}

// Render dispatch table with sorting
function renderDispatchTable() {
    const tbody = document.getElementById('dispatch-tbody');

    // Choose which incidents to show
    let sourceIncidents = showAllIncidents ? allIncidentsUnfiltered : allIncidents;
    const incidents = showAllHistory ? [...sourceIncidents] : [...sourceIncidents].slice(0, 100);

    if (incidents.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="loading">NO INCIDENTS</td></tr>';
        return;
    }

    // Sort incidents
    incidents.sort((a, b) => {
        if (currentSort === 'time') {
            return (b['Call Time'] || '').localeCompare(a['Call Time'] || '');
        } else if (currentSort === 'type') {
            return (a['Incident Type'] || '').localeCompare(b['Incident Type'] || '');
        } else if (currentSort === 'location') {
            return (a['Address'] || '').localeCompare(b['Address'] || '');
        }
        return 0;
    });

    tbody.innerHTML = incidents.map((inc, idx) => {
        const time = inc['Call Time'] || inc['Time'] || inc['Call DateTime'] || inc['Incident Time'] || '--';
        const agency = inc['Agency'] || inc['Department'] || '--';
        const type = inc['Incident Type'] || inc['Type'] || inc['Problem'] || '--';
        const location = inc['Address'] || inc['Location'] || inc['Block'] || '--';

        // Check if industrial incident
        const isIndustrial = /FIRE|EXPLOSION|CHEMICAL|HAZMAT|INDUSTRIAL|REFINERY|PLANT/i.test(type);
        const rowClass = isIndustrial ? 'industrial-incident' : '';

        return `
            <tr class="${rowClass}" data-incident-index="${idx}" onclick="highlightIncident(${idx})">
                <td>${escapeHtml(String(time))}</td>
                <td>${escapeHtml(String(agency))}</td>
                <td>${escapeHtml(String(type))}</td>
                <td>${escapeHtml(String(location))}</td>
            </tr>
        `;
    }).join('');
}

// Highlight incident on map when row is clicked
function highlightIncident(index) {
    const sourceIncidents = showAllIncidents ? allIncidentsUnfiltered : allIncidents;
    const incidents = showAllHistory ? sourceIncidents : sourceIncidents.slice(0, 100);
    const incident = incidents[index];

    if (!incident) return;

    // Remove previous selection
    document.querySelectorAll('.dispatch-table tbody tr').forEach(tr => tr.classList.remove('selected'));

    // Highlight selected row
    document.querySelector(`tr[data-incident-index="${index}"]`)?.classList.add('selected');

    // Auto-switch radio channel if enabled
    if (autoSwitchEnabled && radioFeeds.length > 0) {
        const bestFeed = getRadioFeedForIncident(incident);
        if (bestFeed && (!currentRadioFeed || currentRadioFeed.id !== bestFeed.id)) {
            switchRadioChannel(bestFeed.id);
        }
    }

    // Pan map to incident location if available
    if (incident.has_location && incident.lat && incident.lon) {
        map.setView([incident.lat, incident.lon], 14);

        // Flash the marker
        const marker = incidentMarkers.find(m =>
            m.getLatLng().lat === incident.lat && m.getLatLng().lng === incident.lon
        );

        if (marker) {
            marker.openPopup();
        }
    }
}

// Fetch Facilities and add to map
async function fetchFacilities() {
    try {
        const response = await fetch(`${API_BASE_URL}/facilities`);
        const data = await response.json();

        // Store facilities for plume rendering
        facilities = [];

        Object.entries(data).forEach(([name, loc]) => {
            facilities.push({ name, lat: loc.lat, lon: loc.lon });

            const icon = L.divIcon({
                className: 'custom-marker',
                html: `<div style="
                    background: #ff3333;
                    width: 10px;
                    height: 10px;
                    border: 2px solid #fff;
                    border-radius: 50%;
                    box-shadow: 0 0 4px rgba(255,51,51,0.8);
                "></div>`,
                iconSize: [10, 10]
            });

            const marker = L.marker([loc.lat, loc.lon], { icon })
                .addTo(map)
                .bindPopup(`<strong>${name}</strong><br>${loc.type.toUpperCase()}`);

            markers[name] = marker;
        });

    } catch (error) {
        console.error('Facilities fetch error:', error);
    }
}

// Convert wind direction string to angle (0-360)
function getWindHeading(dirStr) {
    const dirs = {
        'N': 0, 'NNE': 22.5, 'NE': 45, 'ENE': 67.5,
        'E': 90, 'ESE': 112.5, 'SE': 135, 'SSE': 157.5,
        'S': 180, 'SSW': 202.5, 'SW': 225, 'WSW': 247.5,
        'W': 270, 'WNW': 292.5, 'NW': 315, 'NNW': 337.5
    };
    return dirs[dirStr.toUpperCase()] || 0;
}

// Update Wind Overlay
function updateWindOverlay(direction, speed, isRisk) {
    // Label updates
    document.getElementById('wind-dir-overlay').textContent = direction;
    document.getElementById('wind-speed-overlay').textContent = speed;

    // Arrow rotation
    const angle = getWindHeading(direction);
    const blowAngle = (angle + 180) % 360;

    const arrow = document.getElementById('wind-arrow');
    arrow.style.transform = `rotate(${blowAngle}deg)`;

    if (isRisk) {
        arrow.classList.add('risk');
    } else {
        arrow.classList.remove('risk');
    }

    // Draw Plumes on Map
    drawPlume(direction, isRisk);
}

// Draw dispersion plumes from facilities
function drawPlume(windDirStr, isRisk) {
    if (!plumeLayer) return;
    plumeLayer.clearLayers();

    // Check toggle state
    if (!showPlumes) return;

    const windFromAngle = getWindHeading(windDirStr);
    const plumeAngle = (windFromAngle + 180) % 360;

    const length = 0.08;
    const spread = 20;

    // Use Orange for warning, Blue for normal. Less alarmist than Red.
    const color = isRisk ? '#ff9933' : '#3399ff';
    const fillOpacity = isRisk ? 0.3 : 0.15;

    facilities.forEach(fac => {
        const p1 = [fac.lat, fac.lon];

        // Helper scales
        const latScale = 1.0;
        const lonScale = 1.15;

        const trigAngle1 = (90 - (plumeAngle - spread)) * (Math.PI / 180);
        const p2 = [
            fac.lat + (length * Math.sin(trigAngle1) * latScale),
            fac.lon + (length * Math.cos(trigAngle1) * lonScale)
        ];

        const trigAngle2 = (90 - (plumeAngle + spread)) * (Math.PI / 180);
        const p3 = [
            fac.lat + (length * Math.sin(trigAngle2) * latScale),
            fac.lon + (length * Math.cos(trigAngle2) * lonScale)
        ];

        L.polygon([p1, p2, p3], {
            color: 'transparent',
            fillColor: color,
            fillOpacity: fillOpacity,
            weight: 0
        }).addTo(plumeLayer);
    });
}



// Add incident markers to map
function addIncidentMarkers(incidents) {
    // Clear old incident markers
    incidentMarkers.forEach(marker => map.removeLayer(marker));
    incidentMarkers = [];

    if (!incidents || !Array.isArray(incidents)) {
        return;
    }

    incidents.forEach(inc => {
        if (inc.has_location && inc.lat && inc.lon) {
            const icon = L.divIcon({
                className: 'custom-marker',
                html: `<div style="
                    background: #ff9933;
                    width: 12px;
                    height: 12px;
                    border: 2px solid #fff;
                    border-radius: 50%;
                    box-shadow: 0 0 6px rgba(255,153,51,0.9);
                    animation: pulse 2s infinite;
                "></div>`,
                iconSize: [12, 12]
            });

            const time = inc['Call Time'] || inc['Time'] || 'Unknown';
            const type = inc['Incident Type'] || inc['Type'] || 'Unknown';
            const location = inc['Address'] || inc['Location'] || 'Unknown';

            const marker = L.marker([inc.lat, inc.lon], { icon })
                .addTo(map)
                .bindPopup(`
                    <strong>ACTIVE INCIDENT</strong><br>
                    <strong>Time:</strong> ${escapeHtml(time)}<br>
                    <strong>Type:</strong> ${escapeHtml(type)}<br>
                    <strong>Location:</strong> ${escapeHtml(location)}
                `);

            incidentMarkers.push(marker);
        }
    });
}

// Utility: Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// RADIO SCANNER FUNCTIONS
// ============================================

// Fetch available radio feeds
async function fetchRadioFeeds() {
    try {
        const response = await fetch(`${API_BASE_URL}/radio-feeds`);
        const data = await response.json();
        radioFeeds = data.feeds || [];

        // Populate dropdown
        const select = document.getElementById('radio-channel');
        select.innerHTML = '<option value="">-- SELECT CHANNEL --</option>';
        radioFeeds.forEach(feed => {
            const option = document.createElement('option');
            option.value = feed.id;
            option.textContent = `${feed.name} (${feed.coverage})`;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Radio feeds fetch error:', error);
    }
}

// Switch radio channel
function switchRadioChannel(feedId) {
    const feed = radioFeeds.find(f => f.id === feedId);
    if (!feed) return;

    currentRadioFeed = feed;

    // Update status
    document.getElementById('radio-status').textContent = `Now listening: ${feed.name}`;

    // Update dropdown
    document.getElementById('radio-channel').value = feedId;

    // Embed the radio player
    const playerDiv = document.getElementById('radio-player');
    playerDiv.innerHTML = `
        <iframe 
            src="${feed.embed_url}" 
            width="100%" 
            height="120" 
            frameborder="0"
            allow="autoplay"
            style="border-radius: 4px; background: #1a1a2e;">
        </iframe>
        <a href="${feed.url}" target="_blank" class="radio-external-link">
            Open in Broadcastify ↗
        </a>
    `;
}

// Get best radio channel for an incident
function getRadioFeedForIncident(incident) {
    const agency = incident.Agency || '';
    const type = (incident['Incident Type'] || '').toUpperCase();
    const address = (incident['Address'] || '').toUpperCase();

    // Check for location-based matches first (Channelview, Sheldon, Crosby → Harris County North)
    const northAreaKeywords = ['CHANNELVIEW', 'SHELDON', 'CROSBY', 'HUMBLE', 'TOMBALL'];
    if (northAreaKeywords.some(kw => address.includes(kw))) {
        const northFeed = radioFeeds.find(f => f.id === 34687);
        if (northFeed) return northFeed;
    }

    // Fire-related incidents → Houston Fire Digital
    const fireKeywords = ['FIRE', 'SMOKE', 'HAZMAT', 'EXPLOSION', 'CHEMICAL', 'INDUSTRIAL', 'RESCUE', 'EMS'];
    if (agency === 'FD' || fireKeywords.some(kw => type.includes(kw))) {
        const fireFeed = radioFeeds.find(f => f.id === 11690);
        if (fireFeed) return fireFeed;
    }

    // Police incidents → Houston PD
    if (agency === 'PD') {
        const pdFeed = radioFeeds.find(f => f.id === 11689);
        if (pdFeed) return pdFeed;
    }

    // Default to Houston Fire for industrial area
    return radioFeeds.find(f => f.id === 11690) || radioFeeds[0];
}

// ============================================
// WEATHER ALERTS FUNCTIONS
// ============================================

async function fetchWeatherAlerts() {
    try {
        const response = await fetch(`${API_BASE_URL}/weather-alerts`);
        const data = await response.json();

        const container = document.getElementById('weather-alerts');
        const countEl = document.getElementById('weather-count');

        if (data.error) {
            container.innerHTML = '<div class="error">WEATHER DATA UNAVAILABLE</div>';
            countEl.textContent = '0 ACTIVE ALERTS';
            return;
        }

        countEl.textContent = `${data.count} ACTIVE ALERTS`;

        if (!data.alerts || data.alerts.length === 0) {
            container.innerHTML = '<div class="no-alerts">✓ NO ACTIVE WEATHER ALERTS</div>';
            return;
        }

        container.innerHTML = data.alerts.map(alert => `
            <div class="weather-alert ${alert.display_severity}">
                <div class="alert-event">${escapeHtml(alert.event)}</div>
                <div class="alert-headline">${escapeHtml(alert.headline)}</div>
            </div>
        `).join('');

    } catch (error) {
        console.error('Weather alerts fetch error:', error);
        document.getElementById('weather-alerts').innerHTML =
            '<div class="error">WEATHER FEED UNAVAILABLE</div>';
        document.getElementById('weather-count').textContent = '0 ACTIVE ALERTS';
    }
}

// ============================================
// TCEQ EMISSIONS FUNCTIONS
// ============================================

async function fetchTCEQEmissions() {
    try {
        const response = await fetch(`${API_BASE_URL}/tceq-emissions`);
        const data = await response.json();

        const container = document.getElementById('tceq-events');
        const countEl = document.getElementById('tceq-count');

        if (data.error) {
            container.innerHTML = '<div class="error">TCEQ DATA UNAVAILABLE</div>';
            countEl.textContent = '0 EVENTS';
            return;
        }

        countEl.textContent = `${data.count} EVENTS (7 DAYS)`;

        if (!data.events || data.events.length === 0) {
            container.innerHTML = '<div class="no-alerts">✓ NO RECENT EMISSION EVENTS</div>';
            return;
        }

        container.innerHTML = data.events.slice(0, 10).map(event => `
            <div class="tceq-event ${event.severity}">
                <div class="event-facility">${escapeHtml(event.facility)}</div>
                <div class="event-details">
                    ${escapeHtml(event.date)} | ${escapeHtml(event.county)}
                </div>
            </div>
        `).join('');

    } catch (error) {
        console.error('TCEQ fetch error:', error);
        document.getElementById('tceq-events').innerHTML =
            '<div class="error">TCEQ FEED UNAVAILABLE</div>';
        document.getElementById('tceq-count').textContent = '0 EVENTS';
    }
}
