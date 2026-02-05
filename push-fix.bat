@echo off
cd ..\hf-space
copy ..\LYONDELL\api\app.py .
git add app.py
git commit -m "Fix dispatch parser for newline-separated data"
git push
echo.
echo Fix deployed! Wait 1-2 min for rebuild, then refresh dashboard.
pause
