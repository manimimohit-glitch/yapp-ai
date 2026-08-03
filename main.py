"""
Text to Speech AI — powered by edge-tts (free neural voices).

edge-tts taps into the SAME neural voices Microsoft Edge uses for its
"Read Aloud" feature. They sound like a real human, not a robot, and it
costs $0. It works by calling Microsoft's free endpoint over the internet.

HOW IT WORKS (the mental model):
1. We send your text + a chosen voice to Microsoft's TTS endpoint.
2. Microsoft's neural network reads the text and streams back audio.
3. We save that audio as an MP3 file and open it for you to hear.

USAGE:
python main.py "Hello world!"                        # speak one line
python main.py "Hi there" --out greeting.mp3         # custom file name
python main.py --file speech.txt                     # speak a whole file
python main.py --list-voices                         # see all voices
python main.py "..." --voice en-US-GuyNeural         # pick a male voice
python main.py "..." --rate +20% --pitch +50Hz       # faster, higher
"""

import argparse
import asyncio
import sys

import edge_tts

# ---- Your defaults (tweak to taste) ------------------------------------
DEFAULT_VOICE = "en-US-ChristopherNeural"  # deep narrator voice; run --list-voices to browse all
DEFAULT_RATE = "+0%"                  # speech speed: "+20%" faster, "-20%" slower
DEFAULT_PITCH = "+0Hz"                # voice pitch: "+50Hz" higher, "-50Hz" lower


def parse_args():
    parser = argparse.ArgumentParser(description="Convert text to speech with free neural AI voices.")
    parser.add_argument("text", nargs="?", help='Text to speak, e.g. "Hello world!"')
    parser.add_argument("--file", help="Read text from a .txt file instead of the command line")
    parser.add_argument("--out", default="output.mp3", help="Output file name (default: output.mp3)")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="Which voice to use (see --list-voices)")
    parser.add_argument("--rate", default=DEFAULT_RATE, help="Speaking speed, e.g. +10%% or -20%%")
    parser.add_argument("--pitch", default=DEFAULT_PITCH, help="Voice pitch, e.g. +50Hz")
    parser.add_argument("--list-voices", action="store_true", help="List every available voice and exit")
    return parser.parse_args()


async def list_voices():
    """Fetch and print all voices Microsoft offers."""
    voices = await edge_tts.list_voices()
    print(f"{'Voice ID':<25} {'Gender':<8} {'Locale':<8} Friendly name")
    print("-" * 75)
    for v in voices:
        print(f"{v['ShortName']:<25} {v['Gender']:<8} {v['Locale']:<8} {v['FriendlyName']}")


async def speak(text, voice, rate, pitch, out):
    """Send the text to the TTS engine and save the result as MP3."""
    tts = edge_tts.Communicate(text, voice=voice, rate=rate, pitch=pitch)
    await tts.save(out)          # this streams the audio to a file
    print(f"Done! Saved to: {out}")


def get_text(args):
    """Figure out where the text to speak comes from."""
    if args.file:
        with open(args.file, encoding="utf-8") as f:
            return f.read().strip()
    if args.text:
        return args.text
    # No input given -> prompt the user to type (Ctrl+Z then Enter to finish)
    print("Type what you want the AI to say, then press Enter twice:")
    return sys.stdin.read().strip()


def main():
    args = parse_args()

    if args.list_voices:
        asyncio.run(list_voices())
        return

    text = get_text(args)
    if not text:
        sys.exit('No text to speak. Try: python main.py "Hello world!"')

    asyncio.run(speak(text, args.voice, args.rate, args.pitch, args.out))

    # Open the MP3 in your default media player (Windows). Comment this out
    # if you're on Mac/Linux — there you'd use `open out.mp3` instead.
    if sys.platform == "win32":
        import os
        os.startfile(os.path.abspath(args.out))


if __name__ == "__main__":
    main()
