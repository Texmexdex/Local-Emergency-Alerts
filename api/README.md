# Industrial Monitor API

Flask backend for industrial safety monitoring dashboard.

## Deployment to Hugging Face Spaces

1. Create a new Space on huggingface.co
2. Select "Docker" as the SDK
3. Upload these files to the Space
4. Add a `Dockerfile`:

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 7860

CMD ["gunicorn", "-b", "0.0.0.0:7860", "app:app"]
```

5. Your API will be available at: `https://YOUR-USERNAME-SPACE-NAME.hf.space`

## Endpoints

- `GET /api/wind` - Current wind conditions
- `GET /api/caer` - CAER community alerts
- `GET /api/dispatch` - Houston emergency dispatch
- `GET /api/facilities` - Facility coordinates
- `GET /api/health` - Health check

## Local Testing

```bash
pip install -r requirements.txt
python app.py
```

API runs on `http://localhost:7860`
