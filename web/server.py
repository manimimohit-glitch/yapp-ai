"""
Text<->Voice AI — web server.

Serves the Neo-Brutalist website with both TTS and STT features.

RUN IT (from the text-to-voice folder):
    .venv/Scripts/python -m uvicorn web.server:app --reload

Then open http://127.0.0.1:8000 in your browser.

ENDPOINTS
    GET  /               -> the website (index.html)
    GET  /privacy        -> the privacy & data-handling page (privacy.html)
    GET  /healthz        -> lightweight health check for Render
    GET  /api/voices     -> JSON list of available voices (curated locales)
    POST /api/tts        -> {text, voice, rate, pitch} -> MP3 audio stream
    POST /api/transcribe -> audio file -> JSON with timestamps
"""

import os
import tempfile
from pathlib import Path

import edge_tts
import static_ffmpeg
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Register bundled ffmpeg so faster-whisper can find it.
static_ffmpeg.add_paths()

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Yapp.ai", description="Free neural speech and voice AI — no cap")

# Which locales show up in the voice picker (keeps the list clean).
CURATED_LOCALES = {"en-US", "en-GB", "en-IN", "hi-IN"}


class TTSRequest(BaseModel):
    text: str = "Hello world!"
    voice: str = "en-US-ChristopherNeural"  # your narrator voice
    rate: str = "+0%"
    pitch: str = "+0Hz"


def _sign(value: str) -> str:
    """Ensure a param like rate/pitch always carries a +/- sign.
    edge-tts rejects '0%' but accepts '+0%'."""
    return value if value.startswith(("+", "-")) else f"+{value}"


@app.get("/")
async def index():
    """The website itself."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/privacy")
async def privacy():
    """The privacy & data-handling page."""
    return FileResponse(STATIC_DIR / "privacy.html")


@app.get("/healthz")
async def healthz():
    """Lightweight health check so Render can verify the app is up."""
    return {"status": "ok"}


@app.get("/api/voices")
async def list_voices():
    """All voices for the curated locales, so the picker can group them."""
    all_voices = await edge_tts.list_voices()
    curated = [v for v in all_voices if v["Locale"] in CURATED_LOCALES]
    return curated


@app.post("/api/tts")
async def text_to_speech(req: TTSRequest):
    """Turn text into speech. Streams MP3 audio straight back to the page."""
    if not req.text.strip():
        return JSONResponse({"error": "Text is empty"}, status_code=400)

    communicate = edge_tts.Communicate(
        req.text, voice=req.voice, rate=_sign(req.rate), pitch=_sign(req.pitch)
    )

    async def audio_stream():
        # edge-tts sends two kinds of chunks: audio bytes and word timings.
        # We only care about the audio part, which we forward to the browser.
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]

    return StreamingResponse(audio_stream(), media_type="audio/mpeg")


# --------------------------------------------------------------------------- #
# STT — Speech-to-Text using faster-whisper (OpenAI Whisper, CTranslate2)
# --------------------------------------------------------------------------- #

_whisper_model = None


def _get_whisper():
    """Lazy-load the Whisper model on first transcription request."""
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper_model


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    """Turn audio into text with word-level timestamps.

    Accepts any audio format the browser can record (webm, mp4, wav, etc.).
    Returns JSON with segments, each containing word-level timestamps.
    """
    # Save the uploaded audio to a temp file so whisper can read it.
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        content = await audio.read()
        tmp.write(content)
        tmp.close()

        model = _get_whisper()
        segments, info = model.transcribe(
            tmp.name,
            word_timestamps=True,
            vad_filter=True,       # skip silence = faster + cleaner
        )

        result_segments = []
        full_text_parts = []

        for seg in segments:
            words = []
            if seg.words:
                for w in seg.words:
                    words.append({
                        "word": w.word.strip(),
                        "start": round(w.start, 2),
                        "end": round(w.end, 2),
                    })
            result_segments.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip(),
                "words": words,
            })
            full_text_parts.append(seg.text.strip())

        return {
            "text": " ".join(full_text_parts),
            "segments": result_segments,
            "language": info.language,
            "duration": round(info.duration, 2),
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        os.unlink(tmp.name)


# Serve the frontend's static folder (images, etc.) if we add any later.
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
