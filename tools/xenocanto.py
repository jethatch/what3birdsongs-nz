"""Finds one xeno-canto recording for each bird species, and downloads it.

  search    asks the xeno-canto API (v3) about every species in
            <data>/ranges/species.json and keeps each answer in
            <data>/xc/queries/, so nothing is ever asked twice
  choose    picks one recording per species from the kept answers and writes
            <data>/xc/chosen.json and <data>/xc/unmatched.json
  download  downloads the chosen recordings to <data>/xc/audio/

Usage: .venv/bin/python tools/xenocanto.py search|choose|download <data folder> [limit]

Politeness: one request at a time with a pause between them, a project name
and address in every request, a long wait and then a stop if the server
refuses or fails, and only precise tagged queries, as the API asks. The API
key is read from ~/.config/what3birdsongs/xc-key and never written anywhere
else.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://xeno-canto.org/api/3/recordings"
AGENT = "what3birdsongs-nz/0.1 (+https://github.com/jethatch)"
PAUSE = 1.5  # seconds between requests
HOME_COUNTRIES = {"New Zealand"}


class Refused(Exception):
    pass


def key():
    with open(os.path.expanduser("~/.config/what3birdsongs/xc-key")) as f:
        return f.read().strip()


last_request = 0.0


def fetch(url, binary=False, tries=3):
    """One polite request. Waits out the pause since the last one; on a
    refusal or server error waits a minute and tries again, then gives up."""
    global last_request
    for attempt in range(tries):
        wait = last_request + PAUSE - time.time()
        if wait > 0:
            time.sleep(wait)
        last_request = time.time()
        request = urllib.request.Request(url, headers={"User-Agent": AGENT})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = response.read()
                return body if binary else json.loads(body)
        except urllib.error.HTTPError as error:
            if error.code == 400:
                return {"error": json.loads(error.read() or b"{}").get("error", {"code": 400})}
            if error.code in (403, 429) or error.code >= 500:
                print(f"  server said {error.code}; waiting a minute", flush=True)
                time.sleep(60 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as error:
            print(f"  network trouble ({error}); waiting a minute", flush=True)
            time.sleep(60 * (attempt + 1))
    raise Refused(url)


def query(text):
    params = {"query": text, "key": key(), "per_page": 100}
    return f"{API}?{urllib.parse.urlencode(params)}"


def search(data, limit=None):
    folder = os.path.join(data, "xc", "queries")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(data, "ranges", "species.json")) as f:
        species = json.load(f)
    asked = 0
    for n, bird in enumerate(species):
        path = os.path.join(folder, f"{bird['taxon']}.json")
        if os.path.exists(path):
            continue
        if limit is not None and asked >= limit:
            break
        name = bird["name"]
        # Recordings made in New Zealand first; then the best recordings from
        # anywhere, if they are short enough to be a reasonable download; then
        # anything at all, to tell "no good recording" from "not on
        # xeno-canto under this name".
        answers = {}
        for label, text in (
            ("home", f'sp:"{name}" grp:birds cnt:"New Zealand"'),
            ("best", f'sp:"{name}" grp:birds q:A len:"<120"'),
            ("any", f'sp:"{name}" grp:birds'),
        ):
            answer = fetch(query(text))
            answers[label] = answer
            asked += 1
            if label in ("home", "best") and usable(answer.get("recordings", [])):
                break
        with open(path, "w") as f:
            json.dump({"taxon": bird["taxon"], "name": name, "answers": answers}, f)
        found = [len(a.get("recordings", [])) for a in answers.values()]
        print(f"{n + 1}/{len(species)} {name}: {found}", flush=True)


def licence_ok(recording):
    licence = recording.get("lic") or ""
    return "creativecommons.org" in licence and "-nd" not in licence


def usable(recordings):
    return [r for r in recordings if licence_ok(r) and r.get("file") and r.get("status", "identified") == "identified"]


def seconds(length):
    try:
        parts = [int(p) for p in str(length).split(":")]
    except ValueError:
        return 999
    total = 0
    for p in parts:
        total = total * 60 + p
    return total


def score(recording):
    """Higher is better: song over call, recorded at home, good quality, a
    clean recording (no other species, no playback), not too long."""
    kind = (recording.get("type") or "").lower()
    s = 0
    s += 40 if "song" in kind else 20 if "call" in kind else 0
    s += 50 if recording.get("cnt") in HOME_COUNTRIES else 0  # NZ recordings strongly preferred
    s += {"A": 20, "B": 12, "C": 5}.get(recording.get("q"), 0)
    s -= 4 * len(recording.get("also") or [])
    s -= 10 if recording.get("playback-used") == "yes" else 0
    length = seconds(recording.get("length"))
    s -= 0 if 8 <= length <= 90 else 8
    # A share-alike licence without "non-commercial" can't be mixed into one
    # file with the many non-commercial recordings, so a song containing it
    # couldn't be downloaded. Take one only when there's nothing else.
    licence = recording.get("lic") or ""
    s -= 60 if "/by-sa/" in licence else 0
    # Uncompressed files are many times larger to download; take one only
    # when it is clearly the better recording.
    s -= 0 if (recording.get("file-name") or "").lower().endswith(".mp3") else 20
    return s


def choose(data):
    folder = os.path.join(data, "xc", "queries")
    with open(os.path.join(data, "ranges", "species.json")) as f:
        species = json.load(f)
    chosen, unmatched = [], []
    for bird in species:
        path = os.path.join(folder, f"{bird['taxon']}.json")
        if not os.path.exists(path):
            unmatched.append({**bird, "why": "not searched yet"})
            continue
        with open(path) as f:
            kept = json.load(f)
        candidates = []
        for answer in kept["answers"].values():
            candidates += usable(answer.get("recordings", []))
        if not candidates:
            recordings = [r for a in kept["answers"].values() for r in a.get("recordings", [])]
            if not recordings:
                why = "no recordings under this name"
            elif all("_meta" in r or not r.get("file") for r in recordings):
                why = "restricted species: xeno-canto withholds its recordings"
            else:
                why = "no recording with a licence that allows a clip"
            unmatched.append({**bird, "why": why})
            continue
        best = max(candidates, key=score)
        chosen.append({
            **bird,
            "xc": best["id"],
            "en": best.get("en"),
            "rec": best.get("rec"),
            "lic": best.get("lic"),
            "url": best.get("url"),
            "file": best.get("file"),
            "fileName": best.get("file-name"),
            "type": best.get("type"),
            "q": best.get("q"),
            "cnt": best.get("cnt"),
            "length": best.get("length"),
            "sono": (best.get("sono") or {}).get("med"),
            "annotations": [
                [a.get("start_time"), a.get("end_time")]
                for a in ((best.get("annotation-set") or {}).get("annotations") or [])
                if (a.get("scientific_name") or "").lower() == bird["name"].lower()
            ],
        })
    with open(os.path.join(data, "xc", "chosen.json"), "w") as f:
        json.dump(chosen, f, indent=1)
    with open(os.path.join(data, "xc", "unmatched.json"), "w") as f:
        json.dump(unmatched, f, indent=1)
    print(f"{len(chosen)} species with a recording; {len(unmatched)} without")


def download(data, limit=None):
    folder = os.path.join(data, "xc", "audio")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(data, "xc", "chosen.json")) as f:
        chosen = json.load(f)
    fetched = 0
    for n, bird in enumerate(chosen):
        extension = os.path.splitext(bird.get("fileName") or "")[1].lower() or ".mp3"
        path = os.path.join(folder, f"XC{bird['xc']}{extension}")
        if os.path.exists(path):
            continue
        if limit is not None and fetched >= limit:
            break
        body = fetch(bird["file"], binary=True)
        with open(path + ".part", "wb") as f:
            f.write(body)
        os.replace(path + ".part", path)
        fetched += 1
        print(f"{n + 1}/{len(chosen)} {bird['name']}: XC{bird['xc']} {len(body) // 1024} KB", flush=True)


if __name__ == "__main__":
    command, data = sys.argv[1], sys.argv[2]
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else None
    {"search": search, "choose": lambda d, l=None: choose(d), "download": download}[command](data, limit)
