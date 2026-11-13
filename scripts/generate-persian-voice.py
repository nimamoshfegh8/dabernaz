#!/usr/bin/env python3
"""Generate one bundled Persian MP3 containing the spoken numbers 1 through 90."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "voice"
SAMPLE_RATE = 22050
SILENCE_SECONDS = 0.22

UNITS = ["صفر", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه"]
TEENS = ["ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده", "هفده", "هجده", "نوزده"]
TENS = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"]


def number_words(number: int) -> str:
    if number < 10:
        return UNITS[number]
    if number < 20:
        return TEENS[number - 10]
    return TENS[number // 10] + ((" و " + UNITS[number % 10]) if number % 10 else "")


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def main() -> None:
    for executable in ("espeak", "ffmpeg"):
        if shutil.which(executable) is None:
            raise SystemExit(f"Missing required executable: {executable}")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        "version": 1,
        "provider": "bundled-persian-audio",
        "language": "fa-IR",
        "format": "audio/mpeg",
        "sampleRate": SAMPLE_RATE,
        "channels": 1,
        "numbers": {},
    }

    with tempfile.TemporaryDirectory(prefix="dabernaz-fa-voice-") as temp:
        temp_dir = Path(temp)
        wav_path = temp_dir / "fa-numbers.wav"
        merged = bytearray()
        silence = b"\x00\x00" * round(SILENCE_SECONDS * SAMPLE_RATE)

        for number in range(1, 91):
            clip_path = temp_dir / f"{number:02d}.wav"
            spoken = f"عدد {number_words(number)}"
            run([
                "espeak", "-v", "fa+f3", "-s", "138", "-p", "48",
                "-a", "175", "-w", str(clip_path), spoken,
            ])
            with wave.open(str(clip_path), "rb") as clip:
                if (
                    clip.getnchannels() != 1
                    or clip.getsampwidth() != 2
                    or clip.getframerate() != SAMPLE_RATE
                ):
                    raise RuntimeError(f"Unexpected voice format for number {number}")
                frames = clip.readframes(clip.getnframes())

            start_frame = len(merged) // 2
            frame_count = len(frames) // 2
            duration = frame_count / SAMPLE_RATE
            manifest["numbers"][str(number)] = {
                "start": round(start_frame / SAMPLE_RATE, 6),
                "duration": round(duration, 6),
                "text": spoken,
            }
            merged.extend(frames)
            merged.extend(silence)

        with wave.open(str(wav_path), "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(SAMPLE_RATE)
            target.writeframes(merged)

        manifest["durationSeconds"] = round(len(merged) / 2 / SAMPLE_RATE, 3)
        mp3_path = OUTPUT / "fa-numbers.mp3"
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(wav_path), "-map_metadata", "-1",
            "-codec:a", "libmp3lame", "-b:a", "64k",
            "-ar", str(SAMPLE_RATE), "-ac", "1", "-write_xing", "1",
            str(mp3_path),
        ])

    manifest_path = OUTPUT / "fa-numbers.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Generated Persian audio for 90 numbers: "
        f"{mp3_path.stat().st_size:,} bytes, "
        f"{manifest['durationSeconds']} seconds"
    )


if __name__ == "__main__":
    main()
