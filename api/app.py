from flask import Flask, jsonify
from flask_cors import CORS
import requests
from bs4 import BeautifulSoup
import pandas as pd
from datetime import datetime

app = Flask(__name__)
CORS(app)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}

@app.route('/api/wind', methods=['GET'])
def get_wind():
    """Fetch wind data from NWS API"""
    try:
        url = "https://api.weather.gov/gridpoints/HGX/75,98/forecast/hourly"
        r = requests.get(url, headers=HEADERS, timeout=10)
        data = r.json()
        current = data['properties']['periods'][0]
        direction = current['windDirection']
        speed_raw = current['windSpeed']
        
        # Parse speed (e.g., "10 mph" -> 10)
        speed_num = int(speed_raw.split()[0]) if speed_raw else 0
        
        # Risk assessment: N or E winds push plumes toward residential
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
        return jsonify({
            "error": str(e),
            "speed": "OFFLINE",
            "direction": "OFFLINE",
            "is_risk": False
        }), 500

@app.route('/api/caer', methods=['GET'])
def get_caer():
    """Scrape CAER community alert messages"""
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
            
            # Severity classification
            text_lower = (title + body_text).lower()
            severity = "info"
            if any(x in text_lower for x in ['explosion', 'shelter', 'evacuate', 'emergency']):
                severity = "critical"
            elif any(x in text_lower for x in ['flare', 'release', 'incident', 'leak']):
                severity = "warning"
            
            messages.append({
                "title": title,
                "body": body_text.strip(),
                "severity": severity,
                "timestamp": datetime.utcnow().isoformat()
            })
        
        return jsonify({
            "messages": messages,
            "count": len(messages),
            "timestamp": datetime.utcnow().isoformat()
        })
    except Exception as e:
        return jsonify({
            "error": str(e),
            "messages": [],
            "count": 0
        }), 500

@app.route('/api/dispatch', methods=['GET'])
def get_dispatch():
    """Scrape Houston active incidents"""
    url = "https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx"
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        soup = BeautifulSoup(r.text, 'html.parser')
        
        tables = soup.find_all("table")
        if not tables:
            return jsonify({"incidents": [], "count": 0})
        
        target_table = max(tables, key=lambda t: len(t.find_all("tr")))
        data = []
        rows = target_table.find_all("tr")
        
        for row in rows:
            cols = row.find_all(["td", "th"])
            cols = [ele.text.strip() for ele in cols]
            if len(cols) > 1:
                data.append(cols)
        
        if not data:
            return jsonify({"incidents": [], "count": 0})
        
        # Parse into structured data
        if "Agency" in str(data[0]):
            columns = data[0]
            rows_data = data[1:]
        else:
            columns = [f"Col_{i}" for i in range(len(data[0]))]
            rows_data = data
        
        df = pd.DataFrame(rows_data, columns=columns)
        
        # Clean up
        if "Agency" in df.columns:
            df = df[df["Agency"] != "Agency"]
            df = df[~df["Agency"].astype(str).str.contains("This page contains", case=False, na=False)]
        
        # Convert to list of dicts
        incidents = df.to_dict('records')
        
        # Filter high-priority incidents
        keywords = ['SHELDON', 'BAYWAY', 'DECKER', 'CHANNELVIEW', 'PASADENA', 
                   'FIRE', 'HAZMAT', 'LYONDELL', 'EXXON', 'INDUSTRIAL']
        
        priority_incidents = []
        for inc in incidents:
            text = ' '.join(str(v) for v in inc.values()).upper()
            if any(kw in text for kw in keywords):
                priority_incidents.append(inc)
        
        return jsonify({
            "incidents": priority_incidents,
            "total_incidents": len(incidents),
            "priority_count": len(priority_incidents),
            "timestamp": datetime.utcnow().isoformat()
        })
    except Exception as e:
        return jsonify({
            "error": str(e),
            "incidents": [],
            "count": 0
        }), 500

@app.route('/api/facilities', methods=['GET'])
def get_facilities():
    """Return facility coordinates"""
    facilities = {
        "LyondellBasell Channelview": {"lat": 29.8160, "lon": -95.1150, "type": "petrochemical"},
        "ExxonMobil Baytown": {"lat": 29.7450, "lon": -95.0120, "type": "refinery"},
        "Chevron Phillips": {"lat": 29.7400, "lon": -94.9850, "type": "chemical"},
        "Home Base": {"lat": 29.8000, "lon": -95.1200, "type": "residence"}
    }
    return jsonify(facilities)

@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({
        "status": "operational",
        "timestamp": datetime.utcnow().isoformat()
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=7860)
