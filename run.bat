@echo off
title Industrial Monitor - LOCAL
echo Checking Environment...

:: Check if venv exists
if not exist venv (
    echo Creating Python Virtual Environment...
    python -m venv venv
    echo Installing Dependencies...
    call venv\Scripts\activate
    pip install -r requirements.txt
) else (
    call venv\Scripts\activate
)

echo.
echo Launching Dashboard...
echo Local Access URL: http://localhost:8501
echo.

streamlit run app.py
pause