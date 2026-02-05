@echo off
echo Restructuring repository for GitHub Pages...
echo.

REM Move docs contents to root
move docs\index.html .
move docs\style.css .
move docs\app.js .
move docs\README.md README.md

REM Remove old folders and files from git
git rm -r docs/
git rm --cached App.py Dashboard.py setup.bat run.bat requirements.txt setup-git.bat cleanup-repo.bat fix-hf-readme.bat
git rm -r --cached venv api .kiro

REM Add only the frontend files
git add index.html style.css app.js README.md .gitignore

REM Commit
git commit -m "Restructure: Move frontend to root for GitHub Pages"

REM Push
git push origin main --force

echo.
echo Done! Your repo now has:
echo - index.html (at root)
echo - style.css
echo - app.js
echo - README.md
echo.
echo GitHub Pages will now work automatically!
echo Go to: https://github.com/Texmexdex/Local-Emergency-Alerts/settings/pages
echo Set Source to: main branch, / (root)
echo.
pause
