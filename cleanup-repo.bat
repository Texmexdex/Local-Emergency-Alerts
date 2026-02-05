@echo off
echo Cleaning up GitHub repository...
echo.

REM Remove old Streamlit files from git tracking
git rm --cached App.py Dashboard.py setup.bat run.bat requirements.txt
git rm -r --cached venv

REM Add .gitignore
git add .gitignore

REM Commit cleanup
git commit -m "Clean up: Remove old Streamlit files, keep only docs/ and api/"

REM Push changes
git push origin main

echo.
echo Cleanup complete!
echo.
echo Your repo now only contains:
echo - docs/ (frontend for GitHub Pages)
echo - api/ (backend files for reference)
echo - .kiro/ (steering rules)
echo - DEPLOYMENT.md
echo.
pause
