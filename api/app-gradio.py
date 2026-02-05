import gradio as gr
from flask import Flask, jsonify
from flask_cors import CORS
import requests
from bs4 import BeautifulSoup
import pandas as pd
from datetime import datetime
import json

# Same Flask app as before
app = Flask(__name__)
CORS(app)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}

@app.route('/api/wind', methods=['GET'])
def get_wind():
    try:
        url = "https://api.weather.gov/gridpoints/HGX/75,98/forecast/hourly"
        r = requests.get(url, headers=HEADERS, timeout=10)
        data = r.json()
        current = data['properties']['periods'][0]
        direction = current['windDirection']
        speed_raw = current['windSpeed']
        speed_num = int(speed_raw.split()[0]) if speed_raw else 0
        is_risk = any(x in direction for x in ['N', 'E'])
        
        return jsonify({
            "speed": speed_raw,
            "speed_numeric": speed_num,
            "direction": direction,
            "forecast": current['shortForecast'],
            "temperature": current['temperature'],
            "is_risk": is_risk,
            "timestamp": datetime.utcnow().isoformat()
        })
    except Exception as e:
        return jsonify({"error": str(e), "speed": "OFFLINE", "direction": "OFFLINE", "is_risk": False}), 500

@app.route('/api/caer', methods=['GET'])
def get_caer():
    url = "https://www.incident-reporter.net/e-notifycaerfeed/caermessagelive.html"
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        soup = BeautifulSoup(r.text, 'html.parser')
        messages = []
        headers = soup.find_all('h5')
        
        for header in headers:
            title = header.get_text(strip=True)
            body_text = ""
            curr = header.next_sibling
            
            while curr and curr.name != 'h5':
                if hasattr(curr, 'strip'):
                    text_part = curr.strip()
                    if len(text_part) > 1:
                        body_text += text_part + " "
                curr = curr.next_sibling
            
            text_lower = (title + body_text).lower()
            severity = "info"
            if any(x in text_lower for x in ['explosion', 'shelter', 'evacuate', 'emergency']):
                severity = "critical"
            elif any(x in text_lower for x in ['flare', 'release', 'incident', 'leak']):
                severity = "warning"
            
            messages.append({"title": title, "body": body_text.strip(), "severity": severity, "timestamp": datetime.utcnow().isoformat()})
        
        return jsonify({"messages": messages, "count": len(messages), "timestamp": datetime.utcnow().isoformat()})
    except Exception as e:
        return jsonify({"error": str(e), "messages": [], "count": 0}), 500

@app.route('/api/dispatch', methods=['GET'])
def get_dispatch():
    url = "https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx"
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, 'html.parser')
        tables = soup.find_all("table")
        
        if not tables:
            return jsonify({"incidents": [], "total_incidents": 0, "priority_count": 0, "timestamp": datetime.utcnow().isoformat()})
        
        target_table = max(tables, key=lambda t: len(t.find_all("tr")))
        incidents = []
        headers = []
        rows = target_table.find_all("tr")
        
        for idx, row in enumerate(rows):
            cols = row.find_all(["td", "th"])
            row_data = [ele.text.strip() for ele in cols]
            if not row_data or all(not cell for cell in row_data):
                continue
            if idx == 0 or (not headers and 'Agency' in ' '.join(row_data)):
                headers = row_data
                continue
            if any(x in ' '.join(row_data).lower() for x in ['this page contains', 'disclaimer']):
                continue
            if row_data == headers:
                continue
            
            incident = {}
            for i, header in enumerate(headers):
                incident[header] = row_data[i] if i < len(row_data) else ''
            
            if incident.get('Agency') and incident.get('Agency') != 'Agency':
                incidents.append(incident)
        
        keywords = ['SHELDON', 'BAYWAY', 'DECKER', 'CHANNELVIEW', 'PASADENA', 'FIRE', 'HAZMAT', 'LYONDELL', 'EXXON', 'INDUSTRIAL', 'CHEMICAL', 'REFINERY', 'PLANT', 'EXPLOSION', 'LEAK', 'SMOKE', 'ODOR']
        priority_incidents = []
        
        for inc in incidents:
            text = ' '.join(str(v) for v in inc.values()).upper()
            if any(kw in text for kw in keywords):
                address = inc.get('Address') or inc.get('Location') or inc.get('Block') or ''
                if address and len(str(address).strip()) > 3:
                    inc['has_location'] = True
                    inc['lat'] = 29.76 + (abs(hash(str(address))) % 100) / 1000
                    inc['lon'] = -95.36 + (abs(hash(str(address))) % 100) / 1000
                else:
                    inc['has_location'] = False
                priority_incidents.append(inc)
        
        return jsonify({"incidents": priority_incidents, "total_incidents": len(incidents), "priority_count": len(priority_incidents), "timestamp": datetime.utcnow().isoformat()})
    except Exception as e:
        return jsonify({"error": str(e), "incidents": [], "total_incidents": 0, "priority_count": 0, "timestamp": datetime.utcnow().isoformat()}), 500

@app.route('/api/facilities', methods=['GET'])
def get_facilities():
    facilities = {
        "LyondellBasell Channelview": {"lat": 29.8160, "lon": -95.1150, "type": "petrochemical"},
        "ExxonMobil Baytown Refinery": {"lat": 29.7450, "lon": -95.0120, "type": "refinery"},
        "ExxonMobil Baytown Chemical": {"lat": 29.7520, "lon": -95.0050, "type": "chemical"},
        "Chevron Phillips Cedar Bayou": {"lat": 29.7400, "lon": -94.9850, "type": "chemical"},
        "Shell Deer Park": {"lat": 29.6700, "lon": -95.1280, "type": "refinery"},
        "Valero Houston Refinery": {"lat": 29.7350, "lon": -95.2450, "type": "refinery"},
        "Marathon Galveston Bay": {"lat": 29.7180, "lon": -95.0450, "type": "refinery"},
        "Pasadena Refining": {"lat": 29.6910, "lon": -95.1580, "type": "refinery"},
        "Air Liquide Channelview": {"lat": 29.8050, "lon": -95.1100, "type": "industrial_gas"},
        "Arkema Crosby": {"lat": 29.9150, "lon": -95.0620, "type": "chemical"},
        "Huntsman Petrochemical": {"lat": 29.7280, "lon": -95.0380, "type": "chemical"},
        "Ineos Chocolate Bayou": {"lat": 29.2450, "lon": -95.2280, "type": "chemical"},
        "Covestro Baytown": {"lat": 29.7380, "lon": -95.0180, "type": "chemical"},
        "Enterprise Products": {"lat": 29.7620, "lon": -95.0850, "type": "storage"},
        "Kinder Morgan Pasadena": {"lat": 29.6850, "lon": -95.1650, "type": "storage"}
    }
    return jsonify(facilities)

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({"status": "operational", "timestamp": datetime.utcnow().isoformat()})

# Mount Flask app in Gradio
io = gr.mount_gradio_app(app, app, path="/")

if __name__ == "__main__":
    io.launch()
