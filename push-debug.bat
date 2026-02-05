@echo off
cd ..\hf-space
copy ..\LYONDELL\api\app.py .
git add app.py
git commit -m "Add debug endpoint for dispatch troubleshooting"
git push
echo.
echo Debug endpoint added. After HF rebuilds, test it at:
echo https://texmexdex-local-emergency-alerts.hf.space/api/debug/dispatch
pause
