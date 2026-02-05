@echo off
echo Fixing dispatch scraper...
echo.

cd ..\hf-space
copy ..\LYONDELL\api\app.py .
git add app.py
git commit -m "Fix dispatch scraper: handle inconsistent column counts"
git push

echo.
echo Fix deployed to HF Spaces!
echo Wait 1-2 minutes for rebuild, then refresh your dashboard.
echo.
pause
