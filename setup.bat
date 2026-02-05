@echo off
python -m venv venv
call venv\Scripts\activate
pip install streamlit requests beautifulsoup4 pandas lxml
echo Dashboard Setup Complete.
pause