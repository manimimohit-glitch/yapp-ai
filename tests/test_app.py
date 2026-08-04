"""Smoke tests for the Yapp.ai server.

These cover the page routes, the health check, TTS validation, and the
voice-list cache. They avoid real network calls: TTS is tested with empty
text (rejected before Microsoft is contacted), and /api/voices uses a
mocked edge-tts.

Run from the text-to-voice folder:
    .venv/Scripts/python -m pip install -r requirements-dev.txt
    .venv/Scripts/python -m pytest tests/ -v
"""

import edge_tts
import pytest
from fastapi.testclient import TestClient

import web.server as server

client = TestClient(server.app)


def rendered(response):
    """Collapse whitespace so assertions match what the page renders,
    not the raw source formatting (tags/line breaks vary freely)."""
    return " ".join(response.text.split())


# ---------- PAGES ----------

def test_home_serves_html():
    r = client.get("/")
    body = rendered(r)
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    # Post-polish markers: no marquee, trust bar + data note present.
    assert "marquee" not in body
    assert "trust-line" in body
    assert "deleted immediately" in body


def test_privacy_page():
    r = client.get("/privacy")
    body = rendered(r)
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "Privacy" in body
    assert "deleted immediately" in body


# ---------- HEALTH ----------

def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


# ---------- TTS ----------

def test_tts_rejects_empty_text():
    """Empty text is rejected before any network call to Microsoft."""
    r = client.post("/api/tts", json={"text": "   "})
    assert r.status_code == 400
    assert r.json()["error"] == "Text is empty"


# ---------- VOICES (cached) ----------

@pytest.fixture
def fake_voices(monkeypatch):
    """Replace edge-tts with a counter so we can assert on cache hits."""
    calls = {"n": 0}

    async def fake_list_voices():
        calls["n"] += 1
        return [{
            "Locale": "en-US", "ShortName": "en-US-XNeural",
            "FriendlyName": "Microsoft X Online (Natural)", "Gender": "Female",
        }]

    monkeypatch.setattr(edge_tts, "list_voices", fake_list_voices)
    return calls


def test_voices_cached_across_requests(fake_voices):
    """Two requests hit Microsoft once — the second is served from cache."""
    server._voices_cache = None
    server._voices_cached_at = 0.0

    r1 = client.get("/api/voices")
    r2 = client.get("/api/voices")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert fake_voices["n"] == 1
    assert r1.json()[0]["ShortName"] == "en-US-XNeural"
