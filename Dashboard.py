import streamlit as st
import requests
import pandas as pd
from bs4 import BeautifulSoup
from datetime import datetime

st.set_page_config(page_title="Industrial Monitor - Unabridged", layout="wide")

# Facility Coordinates (Approximations for Plume Analysis)
FACILITIES = {
    "LyondellBasell Channelview": {"lat": 29.816, "lon": -95.115},
    "ExxonMobil Baytown": {"lat": 29.745, "lon": -95.012},
    "Chevron Phillips": {"lat": 29.740, "lon": -94.985}
}

# --- DATA FETCHING ---
def get_wind_nws(lat=29.81, lon=-95.11):
    """Fetches real-time wind direction from NWS."""
    try:
        # Step 1: Get office/grid from points
        points_url = f"https://api.weather.gov/points/{lat},{lon}"
        r = requests.get(points_url).json()
        forecast_url = r['properties']['forecastHourly']
        
        # Step 2: Get hourly forecast
        f = requests.get(forecast_url).json()
        current = f['properties']['periods'][0]
        return {
            "speed": current['windSpeed'],
            "direction": current['windDirection'],
            "desc": current['shortForecast']
        }
    except:
        return {"speed": "N/A", "direction": "N/A", "desc": "Error fetching wind data"}

def fetch_all_caer():
    """Scrapes the full unabridged list of CAER messages."""
    url = "https://www.incident-reporter.net/e-notifycaerfeed/caermessagelive.html"
    try:
        r = requests.get(url, timeout=10)
        soup = BeautifulSoup(r.text, 'html.parser')
        # Captures every message entry on the board
        messages = []
        for entry in soup.find_all('div', class_='message-post'): # Target the post container
            messages.append(entry.get_text(separator="\n").strip())
        return messages if messages else ["No messages found on board."]
    except Exception as e:
        return [f"Scraping Error: {e}"]

# --- UI LAYOUT ---
st.title("🚨 Comprehensive Industrial Safety Dashboard")
st.markdown("### Unabridged Real-Time Monitoring")

# Sidebar: Wind & Plume Risk
st.sidebar.header("🌬️ Local Wind Conditions")
wind = get_wind_nws()
st.sidebar.metric("Wind Direction", wind['direction'])
st.sidebar.metric("Wind Speed", wind['speed'])
st.sidebar.write(f"Condition: {wind['desc']}")

# Display Alert Logic
st.sidebar.warning(f"Note: If wind is from the **NE/NNE**, plumes from Channelview facilities may cross the river toward you.")

col1, col2 = st.columns([2, 1])

with col1:
    st.header("📋 All CAER Postings (Full Feed)")
    all_msgs = fetch_all_caer()
    for m in all_msgs:
        with st.expander(f"Message - {m[:50]}...", expanded=True):
            st.write(m)

with col2:
    st.header("🚒 Regional Dispatch")
    dispatch_url = "https://cohweb.houstontx.gov/activeincidents/combined.aspx"
    try:
        df = pd.read_html(dispatch_url)[0]
        # Filter specifically for your high-interest addresses/keywords
        keywords = "SHELDON|BAYWAY|DECKER|INDUSTRIAL|FIRE|HAZMAT"
        filtered_df = df[df.stack().str.contains(keywords, case=False, na=False).any(level=0)]
        if not filtered_df.empty:
            st.dataframe(filtered_df)
        else:
            st.success("No active industrial dispatch calls matching your criteria.")
    except:
        st.error("Could not load dispatch data.")

if st.button('Manual Refresh'):
    st.rerun()