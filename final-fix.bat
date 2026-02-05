@echo off
echo Deploying final fixes...
echo.

cd ..\hf-space
copy ..\LYONDELL\api\app.py .
copy ..\LYONDELL\api\README.md .
git add app.py README.md
git commit -m "Fix: Regex parser for dispatch data + app_port config"
git push

echo.
echo Deployed! Changes:
echo - Regex-based parser extracts ALL incidents with proper fields
echo - Times now included
echo - Better geocoding using Houston grid system
echo - Fixed HF Spaces "Not Found" error with app_port
echo.
echo Wait 1-2 min for rebuild, then refresh dashboard.
pause
