@echo off
cd ..\hf-space
copy ..\LYONDELL\api\app.py .
git add app.py
git commit -m "Use pandas read_html for robust parsing"
git push
echo.
echo Pandas-based parser deployed. Wait 1-2 min for rebuild.
pause
