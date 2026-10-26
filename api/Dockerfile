FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY emergency/ emergency/

EXPOSE 7860

# One worker keeps the in-memory caches shared; threads handle concurrency.
CMD ["gunicorn", "-b", "0.0.0.0:7860", "--workers", "1", "--threads", "8", "--timeout", "60", "app:app"]
