@echo off
echo Updating deployment...
echo.

REM Update GitHub Pages (frontend)
echo [1/2] Pushing frontend updates to GitHub...
git add index.html style.css app.js
git commit -m "Update: Add 15 industrial facilities, emergency incident pins, map legend"
git push origin main

REM Update HF Spaces (backend)
echo.
echo [2/2] Pushing backend updates to HF Spaces...
cd ..\hf-space
copy ..\LYONDELL\api\app.py .
git add app.py
git commit -m "Update: Add more facilities, geocode incidents"
git push

echo.
echo ========================================
echo Updates deployed!
echo ========================================
echo.
echo Changes:
echo - Removed "Home Base" pin
echo - Added 15 industrial facilities across Ship Channel
echo - Emergency incidents now show as orange pulsing pins
echo - Map legend shows facility vs incident markers
echo - Improved dispatch data parsing
echo.
echo Wait 1-2 minutes for deployment, then check:
echo Frontend: https://texmexdex.github.io/Local-Emergency-Alerts/
echo Backend: https://texmexdex-local-emergency-alerts.hf.space
echo.
pause
