@echo off
echo Setting up Git repositories...
echo.

REM Initialize local git repo
git init
git add .
git commit -m "Initial commit: Industrial Safety Monitor"

REM Add GitHub remote and push
echo.
echo Pushing to GitHub...
git branch -M main
git remote add origin https://github.com/Texmexdex/Local-Emergency-Alerts.git
git push -u origin main

echo.
echo GitHub deployment complete!
echo.
echo Now deploying to Hugging Face Spaces...
echo.

REM Clone HF Space
cd ..
git clone https://huggingface.co/spaces/Texmexdex/Local-Emergency-Alerts hf-space
cd hf-space

REM Copy API files
copy ..\LYONDELL\api\* .

REM Push to HF
git add .
git commit -m "Deploy Flask API backend"
git push

echo.
echo ========================================
echo Deployment Complete!
echo ========================================
echo.
echo Frontend: https://texmexdex.github.io/Local-Emergency-Alerts/
echo Backend: https://texmexdex-local-emergency-alerts.hf.space
echo.
echo Next steps:
echo 1. Go to https://github.com/Texmexdex/Local-Emergency-Alerts/settings/pages
echo 2. Set Source to: main branch, /docs folder
echo 3. Wait 2-5 minutes for both to deploy
echo.
pause
