# 🗣️ Text-to-Voice AI (free)

A Python program that turns text into realistic **AI speech** using
[edge-tts](https://github.com/rany2/edge-tts) — the same neural voices
behind Microsoft Edge's "Read Aloud". **100% free**, no API key, no
sign-up.

## Quick start

```bash
# 1. Set up once
python -m venv .venv
.venv/Scripts/python -m pip install edge-tts

# 2. Make it talk
.venv/Scripts/python main.py "Hello world!"
```

The MP3 opens in your default player automatically.

## Usage cheat sheet

```bash
# Speak a single line
.venv/Scripts/python main.py "Hello world!"

# Speak a whole text file
.venv/Scripts/python main.py --file speech.txt

# Choose a voice (run --list-voices to see all ~100)
.venv/Scripts/python main.py "Hi" --voice en-US-GuyNeural

# Change speed and pitch
.venv/Scripts/python main.py "Fast and high" --rate +20% --pitch +50Hz

# Save to a custom filename
.venv/Scripts/python main.py "Hi" --out greeting.mp3

# Browse all available voices
.venv/Scripts/python main.py --list-voices
```

Nice voices to try: `en-US-ChristopherNeural` (deep narrator, **default**),
`en-US-GuyNeural` (clear explainer), `en-US-SteffanNeural` (news anchor),
`en-US-JennyNeural` (female), `en-IN-NeerjaNeural` (Indian English),
`hi-IN-MadhurNeural` (Hindi).

## How it works — the mental model

```
your text ──▶ [Microsoft's neural voice AI] ──▶ MP3 audio
```

1. `edge-tts` sends your text + a voice name to Microsoft's free endpoint.
2. Microsoft's **neural network** (a deep-learning model trained on hours
   of a real person's voice) predicts the sound waves for your sentence.
3. The audio streams back and is saved as an MP3.

### Why "neural" sounds different from old robots

Old text-to-speech glued together small pre-recorded word clips — that's
the robotic "Siri v1" sound. Neural voices don't glue clips; a model
**generates the audio from scratch**, so it gets natural rhythm, stress,
and emotion. This is the same tech as ElevenLabs (which charges money) —
edge-tts just uses Microsoft's free version.

## Concepts you just learned (add to your notes)

| Concept | Where it appears |
|---|---|
| **Virtual environment** | `.venv/` — an isolated folder of packages so different projects never clash |
| **`pip install`** | Downloads packages from PyPI (the Python app store) |
| **Async / `asyncio`** | TTS waits on the *network*, so we use `async` — the program does other work while waiting instead of blocking |
| **Command-line args** | `argparse` — this is how professional CLI tools accept options like `--voice` |
| **API / HTTP endpoint** | We're calling Microsoft's web service over the internet — that's an API call |

## 🌐 The website (Neo-Brutalist UI)

There's also a full website with the AI built in — chunky buttons, hard
shadows, visible grid, the whole neo-brutalist look.

```bash
# From the text-to-voice folder:
.venv/Scripts/python -m uvicorn web.server:app --reload
```

Then open **http://127.0.0.1:8000** in your browser. Type text, pick a
voice, drag speed/pitch, hit **SPEAK IT** — audio streams back instantly.

Files:

```
web/
├── server.py          ← FastAPI backend (/ + /privacy + /healthz + /api/tts + /api/voices)
└── static/
    ├── index.html     ← the whole neo-brutalist frontend, no build step
    └── privacy.html   ← privacy & data-handling page (linked from the footer)
```

There's also a `/healthz` health check wired into `render.yaml`, so Render
stops serving a dead instance automatically.

Why a backend? The neural voices need Python's edge-tts to call
Microsoft. A backend also makes it a real full-stack app (FastAPI serving
a page + JSON API + audio streaming) — exactly the pattern from PaperIQ.

## Ideas to take it further (pick one!)

- **Play the audio without opening a player** — use `pygame` or `playsound`.
- **A talking chatbot** — feed your Ollama's reply into this script.
- **A `tts.py` module** other programs can `import` and call.
- **Save the text → voice history** to a JSON log file.
- **Convert a whole website article** to an audiobook (hint: `requests` + `BeautifulSoup`).

## Troubleshooting

- **"No module named edge-tts"** → you're using system Python, not the venv.
  Always run with `.venv/Scripts/python`.
- **Network errors** → edge-tts needs internet (it calls Microsoft's servers).
- **No sound** → make sure your speakers are on and the MP3 opened.

## Project files

```
text-to-voice/
├── main.py        ← the CLI program (~100 lines, fully commented)
├── web/           ← the website (server.py + static/index.html)
├── README.md      ← this file
├── sample.txt     ← demo input text
└── .venv/         ← isolated Python packages (don't commit this)
```
