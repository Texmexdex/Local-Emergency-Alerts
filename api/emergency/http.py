import threading
import time

import requests

from . import config

_session = requests.Session()
_session.headers.update({"User-Agent": config.USER_AGENT})


def get(url, **kwargs):
    kwargs.setdefault("timeout", config.HTTP_TIMEOUT)
    resp = _session.get(url, **kwargs)
    resp.raise_for_status()
    return resp


def post(url, **kwargs):
    kwargs.setdefault("timeout", config.HTTP_TIMEOUT)
    resp = _session.post(url, **kwargs)
    resp.raise_for_status()
    return resp


class TTLCache:
    """Tiny thread-safe cache so many page loads don't hammer upstream feeds."""

    def __init__(self, ttl_seconds, max_items=2048):
        self.ttl = ttl_seconds
        self.max_items = max_items
        self._data = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            hit = self._data.get(key)
            if hit and time.monotonic() - hit[0] < self.ttl:
                return hit[1]
            return None

    def set(self, key, value):
        with self._lock:
            if len(self._data) >= self.max_items:
                oldest = min(self._data, key=lambda k: self._data[k][0])
                del self._data[oldest]
            self._data[key] = (time.monotonic(), value)

    def get_or_fetch(self, key, fetch):
        value = self.get(key)
        if value is None:
            value = fetch()
            self.set(key, value)
        return value

    def clear(self):
        with self._lock:
            self._data.clear()
