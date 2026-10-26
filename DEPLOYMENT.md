# Deployment

Two free pieces:

- **Frontend**: GitHub Pages serving `index.html`, `app.js` and `style.css` from the repository root.
- **Backend**: a Hugging Face Docker Space built from the `api/` folder.

## Backend (Hugging Face Space)

The Space already exists at `https://huggingface.co/spaces/Texmexdex/Local-Emergency-Alerts` and serves `https://texmexdex-local-emergency-alerts.hf.space`.

### Automatic (recommended)

`.github/workflows/deploy-backend.yml` runs the tests and then pushes `api/` to the Space whenever `api/**` changes on `main`.

1. Create a Hugging Face **write** token: huggingface.co → Settings → Access Tokens.
2. Add it to GitHub as repository secret `HF_TOKEN` (Settings → Secrets and variables → Actions).
3. If your Space has a different name, add repository variable `HF_SPACE` (e.g. `your-name/your-space`).
4. Push to `main`, or run *Deploy backend to Hugging Face* from the Actions tab.

The workflow force-pushes the contents of `api/` as the Space's `main` branch, so the GitHub repo is the source of truth.

### Manual

```bash
git clone https://huggingface.co/spaces/Texmexdex/Local-Emergency-Alerts hf-space
cp -r api/* hf-space/            # app.py, emergency/, Dockerfile, requirements.txt, README.md
cd hf-space && git add -A && git commit -m "Update backend" && git push
```

`api/README.md` contains the Space's configuration header (`sdk: docker`, `app_port: 7860`). Keep it.

Check it after the build finishes (2–5 min):

- `https://texmexdex-local-emergency-alerts.hf.space/api/health`
- `https://texmexdex-local-emergency-alerts.hf.space/api/status`

The `sources` block in `/api/status` shows whether each upstream feed responded and, if not, the error.

## Frontend (GitHub Pages)

1. GitHub → Settings → Pages → Source: *Deploy from a branch*, Branch `main`, folder `/ (root)`.
2. The site appears at `https://texmexdex.github.io/Local-Emergency-Alerts/`.

The API URL is set at the top of `app.js` (`API_BASE`). If you move the backend, change it there, or test without editing using `?api=https://your-backend/api`.

## Phone push (optional)

See [README → Phone alerts](README.md#phone-alerts-ntfy). Requires only the `NTFY_TOPIC` secret.

## Troubleshooting

| Symptom | Check |
|---|---|
| Page says "Showing official NWS alerts while the industrial and fire feeds load" for a long time | The Space is waking up or failed to build. Open the Space's *Logs* tab |
| "Couldn't reach: CAER …" | The CAER site may be down or blocking the Space. Error text is in `/api/status` → `sources.caer.error` |
| Fire calls listed as "not mapped" | The Census geocoder couldn't match that dispatch address; it is still listed, just not placed on the map |
| Scheduled monitor stopped | GitHub disables scheduled workflows after 60 days of no repository activity. Re-enable it in the Actions tab |
