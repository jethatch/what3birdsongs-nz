"""Fetches where iNaturalist has research-grade, non-captive sightings of each
species whose range has a part that circles a pole (see covered() in
tools/ranges.py), so that tools/ranges.py can tell which side of that part is
the range.

Reads the species from <data>/ranges/pole_questions.json (written by
tools/ranges.py). For each, fetches iNaturalist's map grid of sightings at
zoom 3 over New Zealand and the Chathams (four tiles), and keeps one point per occupied grid
square in <data>/inat/sightings/<taxon>.json. Then run tools/ranges.py again.

Usage: .venv/bin/python tools/poles.py <data folder>

One request at a time, 2.5 seconds apart, with the project's name and address;
if the API asks it to slow down, it waits a minute and tries again.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.inaturalist.org/v1/grid"
AGENT = "what3birdsongs-nz/0.1 (+https://github.com/jethatch)"
PAUSE = 2.5
ZOOM = 3
TILES = [(x, y) for x in (7, 0) for y in (4, 5)]  # NZ (x 7) and the Chathams (x 0) at zoom 3

last_request = 0.0


def fetch(url):
    global last_request
    for attempt in range(4):
        wait = last_request + PAUSE - time.time()
        if wait > 0:
            time.sleep(wait)
        last_request = time.time()
        request = urllib.request.Request(url, headers={"User-Agent": AGENT})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (429, 503) or error.code >= 500:
                print(f"  server said {error.code}; waiting a minute", flush=True)
                time.sleep(60 * (attempt + 1))
                continue
            raise
    raise RuntimeError("iNaturalist kept refusing; stopped")


def main(data):
    with open(os.path.join(data, "ranges", "pole_questions.json")) as f:
        taxa = sorted({(q["taxon"], q["name"]) for q in json.load(f)})
    folder = os.path.join(data, "inat", "sightings")
    os.makedirs(folder, exist_ok=True)
    for taxon, name in taxa:
        path = os.path.join(folder, f"{taxon}.json")
        if os.path.exists(path):
            continue
        points = []
        for x, y in TILES:
            query = urllib.parse.urlencode({"taxon_id": taxon, "quality_grade": "research", "captive": "false"})
            tile = fetch(f"{API}/{ZOOM}/{x}/{y}.grid.json?{query}")
            points += [[d["latitude"], d["longitude"]] for d in tile.get("data", {}).values()]
        with open(path, "w") as f:
            json.dump(points, f)
        print(f"{name}: {len(points)} grid squares with sightings", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
