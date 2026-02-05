# Project Structure

## Root Files

- `App.py`: Main dashboard application (primary entry point)
- `Dashboard.py`: Alternative/unabridged dashboard view
- `requirements.txt`: Python dependencies
- `setup.bat`: Initial environment setup script
- `run.bat`: Launch script with auto-setup
- `venv/`: Python virtual environment (gitignored)

## Code Organization

### App.py (Main Dashboard)

- **Configuration**: Page config, location coordinates, HTTP headers
- **Data engines**: Cached functions for fetching wind, CAER, and dispatch data
- **UI layout**: Sidebar + 3-tab interface (Dispatch, CAER, Map)

### Dashboard.py (Alternative View)

- Similar structure but with unabridged CAER feed display
- 2-column layout instead of tabs

## Key Patterns

### Data Fetching

All data fetching functions follow error-handling patterns:
- Try/except blocks with fallback values
- Timeout parameters on HTTP requests
- Graceful degradation when APIs fail

### Caching

Wind data uses `@st.cache_data(ttl=60)` for 60-second cache to reduce API calls.

### Filtering Logic

- **Dispatch logs**: Keyword-based filtering (SHELDON, BAYWAY, CHANNELVIEW, FIRE, HAZMAT, etc.)
- **CAER messages**: Severity-based color coding (error/warning/info)
- **Wind risk**: Direction-based assessment (N/E winds = risk)

## Constants

- `LOCATIONS`: Dictionary of facility coordinates for mapping
- `HEADERS`: User-Agent string for web scraping
- Keywords for filtering are hardcoded strings in filter logic
