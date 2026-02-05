// Configuration
const API_BASE_URL = 'https://texmexdex-local-emergency-alerts.hf.space/api';
const REFRESH_INTERVAL = 30000; // 30 seconds
const USE_MOCK_DATA = false; // Set to true for testing without backend

let map;
let markers = {};
let incidentMarkers = [];
let allIncidents = []; // Store all incidents for history
let currentSort = 'time';
let showAllHistory = false;

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
    
    // Scanner open button
    document.getElementById('scanner-open').addEventListener('click', () => {
        const channelId = document.getElementById('scanner-channel').value;
        window.open(`https://www.broadcastify.com/listen/feed/${channelId}`, '_blank');
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

    fetchFacilities();
}

// Fetch all data sources
async function fetchAllData() {
    updateTimestamp();
    await Promise.all([
        fetchWind(),
        fetchCAER(),
        fetchDispatch()
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
        countEl.textContent = `${data.priority_count || 0} PRIORITY INCIDENTS`;
        
        if (!data.incidents || data.incidents.length === 0) {
            document.getElementById('dispatch-tbody').innerHTML = 
                '<tr><td colspan="4" class="loading">NO PRIORITY INCIDENTS DETECTED</td></tr>';
            return;
        }
        
        // Merge new incidents with history (avoid duplicates)
        data.incidents.forEach(newInc => {
            const exists = allIncidents.some(inc => 
                inc['Call Time'] === newInc['Call Time'] && 
                inc['Address'] === newInc['Address']
            );
            if (!exists) {
                allIncidents.unshift(newInc); // Add to beginning
            }
        });
        
        // Add incident markers to map
        addIncidentMarkers(showAllHistory ? allIncidents : data.incidents);
        
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
    const incidents = showAllHistory ? [...allIncidents] : [...allIncidents].slice(0, 50);
    
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
    const incidents = showAllHistory ? allIncidents : allIncidents.slice(0, 50);
    const incident = incidents[index];
    
    if (!incident || !incident.has_location) return;
    
    // Remove previous selection
    document.querySelectorAll('.dispatch-table tbody tr').forEach(tr => tr.classList.remove('selected'));
    
    // Highlight selected row
    document.querySelector(`tr[data-incident-index="${index}"]`)?.classList.add('selected');
    
    // Pan map to incident location
    map.setView([incident.lat, incident.lon], 14);
    
    // Flash the marker
    const marker = incidentMarkers.find(m => 
        m.getLatLng().lat === incident.lat && m.getLatLng().lng === incident.lon
    );
    
    if (marker) {
        marker.openPopup();
    }
}

// Fetch Facilities and add to map
async function fetchFacilities() {
    try {
        const response = await fetch(`${API_BASE_URL}/facilities`);
        const facilities = await response.json();
        
        Object.entries(facilities).forEach(([name, data]) => {
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
            
            const marker = L.marker([data.lat, data.lon], { icon })
                .addTo(map)
                .bindPopup(`<strong>${name}</strong><br>${data.type.toUpperCase()}`);
            
            markers[name] = marker;
        });
        
    } catch (error) {
        console.error('Facilities fetch error:', error);
    }
}

// Add incident markers to map
function addIncidentMarkers(incidents) {
    // Clear old incident markers
    incidentMarkers.forEach(marker => map.removeLayer(marker));
    incidentMarkers = [];
    
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
