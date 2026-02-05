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
        r.raise_for_status()
        
        # Use pandas - it's better at handling messy tables
        tables = pd.read_html(r.text)
        
        if not tables:
            return jsonify({
                "incidents": [],
                "total_incidents": 0,
                "priority_count": 0,
                "timestamp": datetime.utcnow().isoformat()
            })
        
        # Get the largest table
        df = max(tables, key=lambda x: len(x))
        
        # Clean column names
        df.columns = df.columns.astype(str)
        
        # If first row looks like headers, use it
        if 'Agency' not in df.columns and len(df) > 0:
            if 'Agency' in str(df.iloc[0].values):
                df.columns = df.iloc[0]
                df = df[1:]
        
        # Remove disclaimer rows
        df = df[~df.astype(str).apply(lambda x: x.str.contains('This page contains|disclaimer', case=False, na=False)).any(axis=1)]
        
        # Ensure we have the right columns
        expected_cols = ['Agency', 'Address', 'Cross Street', 'Key Map', 'Call Time', 'Incident Type', 'Combined Response']
        
        # If columns don't match, try to map them
        if 'Agency' not in df.columns and len(df.columns) >= 7:
            df.columns = expected_cols[:len(df.columns)]
        
        # Convert to dict
        all_incidents_raw = df.to_dict('records')
        
        # Clean ALL incidents first
        all_incidents_cleaned = []
        for inc in all_incidents_raw:
            # Skip if not a valid incident
            agency = str(inc.get('Agency', ''))
            if agency not in ['FD', 'PD']:
                continue
            
            cleaned = {
                'Agency': str(inc.get('Agency', '')),
                'Address': str(inc.get('Address', '')),
                'Cross Street': str(inc.get('Cross Street', '')),
                'Key Map': str(inc.get('Key Map', '')),
                'Call Time': str(inc.get('Call Time', '') or inc.get('Call Time(Opened)', '')),
                'Incident Type': str(inc.get('Incident Type', '')),
                'Combined Response': str(inc.get('Combined Response', 'N'))
            }
            
            # Add geocoding
            address = cleaned['Address']
            key_map = cleaned['Key Map']
            
            if address and len(address) > 2 and address != 'nan':
                cleaned['has_location'] = True
                try:
                    grid_num = int(''.join(filter(str.isdigit, key_map))) if key_map else 500
                    # Houston grid system
                    cleaned['lat'] = 29.5 + (grid_num % 100) * 0.01
                    cleaned['lon'] = -95.6 + (grid_num // 100) * 0.1
                except:
                    cleaned['lat'] = 29.76
                    cleaned['lon'] = -95.36
            else:
                cleaned['has_location'] = False
            
            all_incidents_cleaned.append(cleaned)
        
        # Filter high-priority incidents from cleaned list
        keywords = ['SHELDON', 'BAYWAY', 'DECKER', 'CHANNELVIEW', 'PASADENA', 
                   'FIRE', 'HAZMAT', 'LYONDELL', 'EXXON', 'INDUSTRIAL', 'CHEMICAL',
                   'REFINERY', 'PLANT', 'EXPLOSION', 'LEAK', 'SMOKE', 'ODOR', 'APARTMENT',
                   'HOUSE', 'ALARM', 'CRASH', 'MAJOR']
        
        priority_incidents = []
        for inc in all_incidents_cleaned:
            text = ' '.join(str(v) for v in inc.values()).upper()
            if any(kw in text for kw in keywords):
                priority_incidents.append(inc)
        
        return jsonify({
            "incidents": priority_incidents,
            "all_incidents": all_incidents_cleaned,
            "total_incidents": len(all_incidents_cleaned),
            "priority_count": len(priority_incidents),
            "timestamp": datetime.utcnow().isoformat()
        })
        
    except requests.exceptions.RequestException as e:
        return jsonify({
            "error": f"Network error: {str(e)}",
            "incidents": [],
            "total_incidents": 0,
            "priority_count": 0,
            "timestamp": datetime.utcnow().isoformat()
        }), 500
    except Exception as e:
        return jsonify({
            "error": f"Parse error: {str(e)}",
            "incidents": [],
            "total_incidents": 0,
            "priority_count": 0,
            "timestamp": datetime.utcnow().isoformat()
        }), 500

@app.route('/api/facilities', methods=['GET'])
def get_facilities():
    """Return facility coordinates for Houston Ship Channel industrial area"""
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
    """Health check endpoint"""
    return jsonify({
        "status": "operational",
        "timestamp": datetime.utcnow().isoformat()
    })

@app.route('/api/debug/dispatch', methods=['GET'])
def debug_dispatch():
    """Debug endpoint to see raw dispatch data"""
    url = "https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx"
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        soup = BeautifulSoup(r.text, 'html.parser')
        tables = soup.find_all("table")
        
        debug_info = {
            "tables_found": len(tables),
            "sample_rows": [],
            "total_rows": 0
        }
        
        if tables:
            target_table = max(tables, key=lambda t: len(t.find_all("tr")))
            rows = target_table.find_all("tr")
            debug_info["total_rows"] = len(rows)
            
            # Get first 10 rows as sample
            for row in rows[:10]:
                cols = row.find_all(["td", "th"])
                row_data = [ele.text.strip() for ele in cols]
                if row_data:
                    debug_info["sample_rows"].append(row_data)
        
        return jsonify(debug_info)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=7860)
