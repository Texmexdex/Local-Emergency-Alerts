@echo off
echo Fixing HF Spaces README...
cd ..\hf-space
copy ..\LYONDELL\api\README.md .
git add README.md
git commit -m "Fix README configuration header"
git push
echo.
echo Done! HF Space should rebuild automatically.
pause
