// Configuration
const API_BASE_URL = 'https://texmexdex-local-emergency-alerts.hf.space/api';
const REFRESH_INTERVAL = 30000; // 30 seconds

let map;
let markers = {};
let incidentMarkers = [];

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
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        const tbody = document.getElementById('dispatch-tbody');
        const countEl = document.getElementById('dispatch-count');
        
        countEl.textContent = `${data.priority_count} PRIORITY INCIDENTS`;
        
        if (data.incidents.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="loading">NO PRIORITY INCIDENTS</td></tr>';
            return;
        }
        
        // Add incident markers to map
        addIncidentMarkers(data.incidents);
        
        tbody.innerHTML = data.incidents.map(inc => {
            const time = inc['Call Time'] || inc['Time'] || '--';
            const agency = inc['Agency'] || '--';
            const type = inc['Incident Type'] || inc['Type'] || '--';
            const location = inc['Address'] || inc['Location'] || '--';
            
            return `
                <tr>
                    <td>${escapeHtml(time)}</td>
                    <td>${escapeHtml(agency)}</td>
                    <td>${escapeHtml(type)}</td>
                    <td>${escapeHtml(location)}</td>
                </tr>
            `;
        }).join('');
        
    } catch (error) {
        console.error('Dispatch fetch error:', error);
        document.getElementById('dispatch-tbody').innerHTML = 
            '<tr><td colspan="4" class="error">DISPATCH FEED UNAVAILABLE</td></tr>';
        document.getElementById('dispatch-count').textContent = '0 PRIORITY INCIDENTS';
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
