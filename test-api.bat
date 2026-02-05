@echo off
echo Testing API endpoints locally...
echo.

cd api

echo Starting Flask server...
start "Flask API" python app.py

echo Waiting for server to start...
timeout /t 5 /nobreak > nul

echo.
echo Testing endpoints:
echo.

echo [1/4] Health check...
curl http://localhost:7860/api/health
echo.
echo.

echo [2/4] Wind data...
curl http://localhost:7860/api/wind
echo.
echo.

echo [3/4] CAER messages...
curl http://localhost:7860/api/caer
echo.
echo.

echo [4/4] Dispatch log...
curl http://localhost:7860/api/dispatch
echo.
echo.

echo.
echo Test complete! Check output above for errors.
echo Press any key to stop the server...
pause > nul

taskkill /FI "WINDOWTITLE eq Flask API*" /F
