"""Looks up, by English name, the species xeno-canto had no recordings for
under iNaturalist's scientific name (usually a difference of taxonomy), and
lists what xeno-canto calls them, for review before anything is used.

Reads <data>/xc/unmatched.json and <data>/inat/photos.json; keeps each
answer in <data>/xc/byname/; writes <data>/xc/byname.json.

Usage: .venv/bin/python tools/byname.py <data folder>
"""

import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from xenocanto import fetch, query  # same polite pace, agent and key handling


def main(data):
    with open(os.path.join(data, "xc", "unmatched.json")) as f:
        unmatched = [b for b in json.load(f) if b["why"] == "no recordings under this name"]
    with open(os.path.join(data, "inat", "photos.json")) as f:
        english = {p["taxon"]: p.get("en") for p in json.load(f)}
    out = []
    for bird in unmatched:
        en = english.get(bird["taxon"]) or ""
        en = en.split(" (")[-1].rstrip(")") if "(" in en else en  # "Warou (Welcome Swallow)" -> "Welcome Swallow"
        path = os.path.join(data, "xc", "byname", f"{bird['taxon']}.json")
        if not os.path.exists(path):
            answer = fetch(query(f'en:"={en}" grp:birds')) if en else {"recordings": []}
            with open(path, "w") as f:
                json.dump(answer, f)
        with open(path) as f:
            answer = json.load(f)
        names = collections.Counter(f"{r.get('gen')} {r.get('sp')}" for r in answer.get("recordings", []))
        out.append({"taxon": bird["taxon"], "inat": bird["name"], "en": en,
                    "xc": names.most_common(3), "total": answer.get("numRecordings")})
        print(f"{bird['name']} ({en}): {names.most_common(3)}", flush=True)
    with open(os.path.join(data, "xc", "byname.json"), "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1])
