# Industrial Safety Monitor - Frontend

Professional emergency operations dashboard for monitoring industrial incidents in the Houston Ship Channel area.

## Deployment to GitHub Pages

1. Push this `docs/` folder to your GitHub repository
2. Go to repository Settings → Pages
3. Set Source to "Deploy from a branch"
4. Select branch: `main` (or `master`)
5. Select folder: `/docs`
6. Save

Your site will be live at: `https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/`

## Configuration

Before deploying, update the API endpoint in `docs/app.js`:

```javascript
const API_BASE_URL = 'https://YOUR-HF-SPACE.hf.space/api';
```

Replace `YOUR-HF-SPACE` with your actual Hugging Face Space URL after deploying the backend.

## Local Testing

Simply open `index.html` in a browser, or use a local server:

```bash
# Python
python -m http.server 8000

# Node.js
npx http-server docs/
```

Then visit `http://localhost:8000`

## Features

- Real-time wind conditions with plume risk assessment
- CAER community alert feed with severity classification
- Emergency dispatch log with priority filtering
- Interactive facility map
- Auto-refresh every 30 seconds
- Professional dark theme optimized for monitoring
