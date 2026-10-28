"""Cuts a short clip from each downloaded xeno-canto recording.

For each recording in <data>/xc/chosen.json found in <data>/xc/audio/,
writes <data>/clips/<taxon>.mp3: about six seconds, mono, chosen where the
bird is loudest (or where an annotation says it sings), high-passed to take
out rumble, brought to an even loudness (with a limiter so no clip peaks above -2 dB), faded in and out, and encoded as a
40 kbit/s MP3. Writes <data>/clips/clips.json with the window used.

Usage: .venv/bin/python tools/clips.py <data folder>
Needs ffmpeg on the PATH.
"""

import json
import os
import subprocess
import sys

import numpy as np

RATE = 32000
CLIP = 6.0  # seconds
FRAME = 0.05
PREROLL = 0.15


def decode(path):
    """The recording as mono float samples at RATE, high-passed."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(RATE),
         "-af", "highpass=f=700", "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32)


def window(samples, annotations):
    """Start of the CLIP-second stretch to keep."""
    total = len(samples) / RATE
    if total <= CLIP:
        return 0.0
    for start, end in annotations or []:
        if start is not None and start < total:
            return max(0.0, min(total - CLIP, start - PREROLL))
    frame = int(FRAME * RATE)
    count = len(samples) // frame
    energy = (samples[: count * frame].reshape(count, frame) ** 2).mean(axis=1)
    span = int(CLIP / FRAME)
    if count <= span:
        return 0.0
    sums = np.convolve(energy, np.ones(span), mode="valid")
    best = int(np.argmax(sums))
    # Start where the singing does, not mid-silence.
    inside = energy[best:best + span]
    loud = np.nonzero(inside >= 0.2 * inside.max())[0]
    onset = best + (int(loud[0]) if len(loud) else 0)
    start = max(0.0, onset * FRAME - PREROLL)
    return min(start, total - CLIP)


def main(data):
    with open(os.path.join(data, "xc", "chosen.json")) as f:
        chosen = json.load(f)
    audio = os.path.join(data, "xc", "audio")
    out = os.path.join(data, "clips")
    os.makedirs(out, exist_ok=True)
    made = {}
    index_path = os.path.join(out, "clips.json")
    if os.path.exists(index_path):
        with open(index_path) as f:
            made = json.load(f)
    for n, bird in enumerate(chosen):
        name = f"XC{bird['xc']}"
        source = next((os.path.join(audio, f) for f in os.listdir(audio) if f.startswith(name + ".")), None)
        target = os.path.join(out, f"{bird['taxon']}.mp3")
        if not source or (os.path.exists(target) and made.get(str(bird["taxon"]), {}).get("xc") == bird["xc"]):
            continue
        try:
            samples = decode(source)
        except subprocess.CalledProcessError as error:
            print(f"{bird['name']}: couldn't decode {name}: {error.stderr[:200]!r}", flush=True)
            continue
        start = window(samples, bird.get("annotations"))
        length = min(CLIP, len(samples) / RATE - start)
        fade = min(0.3, length / 4)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", source,
             "-ac", "1", "-ar", str(RATE),
             "-af", f"highpass=f=250,loudnorm=I=-18:TP=-2:LRA=11,alimiter=limit=0.8:level=false,afade=t=in:d=0.02,afade=t=out:st={max(0, length - fade):.3f}:d={fade:.3f}",
             "-c:a", "libmp3lame", "-b:a", "40k", target],
            check=True,
        )
        made[str(bird["taxon"])] = {"xc": bird["xc"], "start": round(start, 2), "seconds": round(length, 2)}
        print(f"{n + 1}/{len(chosen)} {bird['name']}: {start:.1f}s +{length:.1f}s, {os.path.getsize(target) // 1024} KB", flush=True)
        if n % 25 == 0:
            with open(index_path, "w") as f:
                json.dump(made, f)
    with open(index_path, "w") as f:
        json.dump(made, f)


if __name__ == "__main__":
    main(sys.argv[1])
