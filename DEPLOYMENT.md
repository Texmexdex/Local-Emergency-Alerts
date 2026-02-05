# Deployment Guide

Complete guide for deploying the Industrial Safety Monitor with GitHub Pages frontend and Hugging Face Spaces backend.

## Architecture

- **Frontend**: Static HTML/CSS/JS hosted on GitHub Pages
- **Backend**: Flask API hosted on Hugging Face Spaces
- **Communication**: Frontend fetches JSON data from backend API via CORS

---

## Part 1: Deploy Backend to Hugging Face Spaces

### Step 1: Create a Hugging Face Account
1. Go to https://huggingface.co/join
2. Create a free account

### Step 2: Create a New Space
1. Click "New Space" from your profile
2. Configure:
   - **Space name**: `industrial-monitor-api` (or your choice)
   - **License**: MIT
   - **SDK**: Docker
   - **Visibility**: Public (required for free tier)

### Step 3: Upload Backend Files
Upload these files from the `api/` folder to your Space:
- `app.py`
- `requirements.txt`
- `Dockerfile`
- `README.md`

You can either:
- Use the web interface to upload files
- Clone the Space repo and push via git:
  ```bash
  git clone https://huggingface.co/spaces/YOUR-USERNAME/industrial-monitor-api
  cd industrial-monitor-api
  # Copy files from api/ folder
  git add .
  git commit -m "Initial backend deployment"
  git push
  ```

### Step 4: Wait for Build
- HF Spaces will automatically build your Docker container
- This takes 2-5 minutes
- Check the "Logs" tab for build progress

### Step 5: Test Your API
Once deployed, your API will be at:
```
https://YOUR-USERNAME-industrial-monitor-api.hf.space
```

Test endpoints:
- https://YOUR-USERNAME-industrial-monitor-api.hf.space/api/health
- https://YOUR-USERNAME-industrial-monitor-api.hf.space/api/wind
- https://YOUR-USERNAME-industrial-monitor-api.hf.space/api/caer

---

## Part 2: Deploy Frontend to GitHub Pages

### Step 1: Update API URL
Edit `docs/app.js` and replace the API_BASE_URL:

```javascript
const API_BASE_URL = 'https://YOUR-USERNAME-industrial-monitor-api.hf.space/api';
```

### Step 2: Push to GitHub
```bash
git add .
git commit -m "Deploy industrial monitor"
git push origin main
```

### Step 3: Enable GitHub Pages
1. Go to your repository on GitHub
2. Click "Settings" → "Pages"
3. Under "Source", select:
   - Branch: `main`
   - Folder: `/docs`
4. Click "Save"

### Step 4: Access Your Site
After 1-2 minutes, your dashboard will be live at:
```
https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/
```

---

## Testing

1. Open your GitHub Pages URL
2. Verify all panels load data:
   - Wind conditions should show direction/speed
   - CAER messages should populate
   - Dispatch log should show incidents
   - Map should display facility markers

3. Check browser console (F12) for any errors

---

## Troubleshooting

### Backend Issues

**Build fails on HF Spaces:**
- Check Logs tab for error messages
- Verify Dockerfile syntax
- Ensure all dependencies in requirements.txt are valid

**API returns 500 errors:**
- Check Space logs for Python errors
- Test individual endpoints
- Verify external APIs (NWS, CAER, dispatch) are accessible

**CORS errors:**
- Ensure flask-cors is installed
- Verify CORS(app) is called in app.py

### Frontend Issues

**"OFFLINE" or "UNAVAILABLE" messages:**
- Verify API_BASE_URL is correct in app.js
- Check browser console for fetch errors
- Test API endpoints directly in browser

**Map not loading:**
- Check browser console for Leaflet errors
- Verify internet connection (Leaflet tiles load from CDN)

**Data not refreshing:**
- Check browser console for JavaScript errors
- Verify auto-refresh interval is set

---

## Maintenance

### Update Backend
1. Edit files in `api/` folder
2. Push to HF Spaces repo
3. Space will automatically rebuild

### Update Frontend
1. Edit files in `docs/` folder
2. Push to GitHub
3. GitHub Pages will automatically redeploy

### Monitor Usage
- HF Spaces free tier: Check usage in Space settings
- GitHub Pages: Unlimited bandwidth for public repos

---

## Cost

Both services are **completely free** for public projects:
- Hugging Face Spaces: Free tier with Docker support
- GitHub Pages: Free for public repositories

---

## Security Notes

- No API keys required (all data sources are public)
- Backend uses read-only web scraping
- No user data collected or stored
- All traffic over HTTPS
