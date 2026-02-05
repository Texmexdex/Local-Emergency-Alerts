# Technology Stack

## Framework

- **Streamlit**: Web application framework for Python dashboards
- **Python 3.x**: Primary language

## Key Libraries

- `streamlit`: UI framework and page configuration
- `requests`: HTTP client for API calls and web scraping
- `beautifulsoup4` + `lxml`: HTML parsing for CAER and dispatch feeds
- `pandas`: Data manipulation and tabular display
- `openpyxl`: Excel file support (dependency)

## Environment Setup

The project uses a Python virtual environment (`venv/`) for dependency isolation.

### Setup Commands

```bash
# Initial setup (creates venv and installs dependencies)
setup.bat

# Or manually:
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### Running the Application

```bash
# Launch dashboard (auto-creates venv if missing)
run.bat

# Or manually:
venv\Scripts\activate
streamlit run App.py
```

The dashboard runs on `http://localhost:8501` by default.

## External APIs

- **NWS API**: `api.weather.gov` - No authentication required, uses grid-based forecasts
- **CAER Feed**: Web scraping with BeautifulSoup
- **Houston Dispatch**: Web scraping with pandas HTML parser

All HTTP requests use custom User-Agent headers to avoid blocking.
