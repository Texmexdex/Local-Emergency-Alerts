@echo off
cd ..\hf-space
copy ..\LYONDELL\api\app.py .
git add app.py
git commit -m "Return all incidents in API response"
git push
echo.
echo Backend updated! Wait 1-2 min for HF rebuild.
pause
