import streamlit as st
import requests
import pandas as pd
from bs4 import BeautifulSoup
from datetime import datetime

# --- CONFIGURATION ---
st.set_page_config(
    page_title="Industrial Command",
    layout="wide",
    page_icon="☣️",
    initial_sidebar_state="expanded"
)

# Coordinates
LOCATIONS = {
    "LyondellBasell (Channelview)": [29.8160, -95.1150],
    "ExxonMobil (Baytown)": [29.7450, -95.0120],
    "Chevron Phillips": [29.7400, -94.9850],
    "Home Base (Approx)": [29.8000, -95.1200]
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

# --- DATA ENGINES ---

@st.cache_data(ttl=60)
def get_wind_data():
    try:
        url = "https://api.weather.gov/gridpoints/HGX/75,98/forecast/hourly"
        r = requests.get(url, headers=HEADERS, timeout=5)
        data = r.json()
        current = data['properties']['periods'][0]
        direction = current['windDirection']
        is_risk = any(x in direction for x in ['N', 'E'])
        return {
            "speed": current['windSpeed'],
            "direction": direction,
            "forecast": current['shortForecast'],
            "is_risk": is_risk
        }
    except:
        return {"speed": "--", "direction": "--", "forecast": "Offline", "is_risk": False}

def fetch_caer_raw():
    url = "https://www.incident-reporter.net/e-notifycaerfeed/caermessagelive.html"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
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
            messages.append({"title": title, "body": body_text})
        return messages if messages else []
    except Exception as e:
        return [{"title": "Connection Error", "body": str(e)}]

def fetch_dispatch_logs():
    url = "https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(r.text, 'html.parser')
        
        # 1. FIND THE REAL TABLE
        # We look for all tables, and pick the one with the most rows.
        tables = soup.find_all("table")
        if not tables:
            return pd.DataFrame()
            
        # Sort tables by number of rows (descending)
        target_table = max(tables, key=lambda t: len(t.find_all("tr")))
        
        # 2. MANUAL ROW PARSING
        # We iterate over every <tr> and extract text from every <td>
        data = []
        rows = target_table.find_all("tr")
        
        for row in rows:
            cols = row.find_all(["td", "th"])
            cols = [ele.text.strip() for ele in cols]
            # Filter out empty rows or the 1-column disclaimer rows
            if len(cols) > 1:
                data.append(cols)
        
        if not data:
            return pd.DataFrame()

        # 3. CONVERT TO DATAFRAME
        # We blindly take the first row as columns, or generate generic ones if it looks like data
        # Check if first row is header ("Agency" check)
        if "Agency" in str(data[0]):
            columns = data[0]
            rows_data = data[1:]
        else:
            # If the parser missed the header, just give generic names so we see the data
            columns = [f"Col_{i}" for i in range(len(data[0]))]
            rows_data = data

        df = pd.DataFrame(rows_data, columns=columns)
        
        # 4. FILTERING
        # Now we can safely filter because the columns are physically separated
        if "Agency" in df.columns:
            # Remove header repetition in body
            df = df[df["Agency"] != "Agency"]
            # Remove disclaimer rows if they snuck in
            df = df[~df["Agency"].astype(str).str.contains("This page contains", case=False, na=False)]
            
            # Select key columns if present
            desired_cols = ["Agency", "Address", "Call Time", "Incident Type"]
            # Filter to keep only columns that actually exist in the parsed data
            final_cols = [c for c in desired_cols if c in df.columns]
            if final_cols:
                df = df[final_cols]

        return df

    except Exception as e:
        # Fallback: Create a dataframe with the error so you see what happened
        return pd.DataFrame([["Scraper Error", str(e)]], columns=["Error", "Details"])

# --- UI LAYOUT ---

with st.sidebar:
    st.header("📡 Sensor Array")
    wind = get_wind_data()
    st.metric("Wind Speed", wind['speed'])
    st.metric("Direction", wind['direction'], delta="Risk" if wind['is_risk'] else "Clear", delta_color="inverse")
    if st.button("🔄 Force Refresh System"):
        st.rerun()

st.title("☣️ Industrial Command Center")

if wind['is_risk']:
    st.error(f"⚠️ **WIND ALERT:** Blowing from {wind['direction']}. Plumes from Channelview may cross river.")
else:
    st.success(f"✅ **WIND CLEAR:** Blowing from {wind['direction']}. Plumes pushing away from residence.")

tab1, tab2, tab3 = st.tabs(["🔥 Dispatch Logs", "📢 CAER Messages", "📍 Map"])

# --- TAB 1: DISPATCH ---
with tab1:
    st.subheader("Live Fire & Hazmat Dispatch")
    df = fetch_dispatch_logs()
    
    if not df.empty:
        search_term = st.text_input("🔍 Search Logs (e.g., 'Lyondell', 'Fire', 'Sheldon')", "")
        
        if search_term:
            # Search all columns
            mask = df.apply(lambda x: x.astype(str).str.contains(search_term, case=False, na=False)).any(axis=1)
            display_df = df[mask]
        else:
            # Default Risk Filter
            keywords = 'SHELDON|BAYWAY|DECKER|CHANNELVIEW|PASADENA|FIRE|HAZMAT|LYONDELL|EXXON'
            mask = df.apply(lambda x: x.astype(str).str.contains(keywords, case=False, na=False)).any(axis=1)
            display_df = df[mask]
        
        if not display_df.empty:
            st.dataframe(display_df, hide_index=True, use_container_width=True)
        else:
            st.info("No active incidents found matching criteria.")
            with st.expander("View Full Log (Unfiltered)"):
                st.dataframe(df, hide_index=True, use_container_width=True)
    else:
        st.warning("Dispatch table returned no data.")

# --- TAB 2: CAER ---
with tab2:
    st.subheader("EHCMA CAER Community Feed")
    msgs = fetch_caer_raw()
    if not msgs:
        st.info("No active messages on the board.")
    for m in msgs:
        with st.container():
            text_content = (m['title'] + m['body']).lower()
            if any(x in text_content for x in ['boom', 'explosion', 'shelter', 'leak']):
                st.error(f"### {m['title']}")
                st.write(m['body'])
            elif "lyondell" in text_content or "exxon" in text_content:
                st.warning(f"### {m['title']}")
                st.write(m['body'])
            else:
                st.info(f"### {m['title']}")
                st.write(m['body'])
            st.divider()

# --- TAB 3: MAP ---
with tab3:
    st.subheader("Sector Overview")
    map_data = pd.DataFrame.from_dict(LOCATIONS, orient='index', columns=['lat', 'lon'])
    st.map(map_data, zoom=12, use_container_width=True)