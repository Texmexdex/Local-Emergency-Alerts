@echo off
echo Pushing API files to Hugging Face Space...

cd api

git add app.py Dockerfile requirements.txt README.md .gitignore
git commit -m "Update backend API"
git push hf main

cd ..
echo Done!
pause
