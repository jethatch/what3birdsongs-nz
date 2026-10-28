"""Adds the recordings found by tools/byname.py to each species' kept
xeno-canto answers, so that `xenocanto.py choose` can pick from them.

For each species xeno-canto knew under another scientific name, takes the
name most of the English-name results share, and only its recordings.
Agreed with Jim Thatcher (28 Oct 2026): use the match as found, and list
every one for later review (written to <data>/xc/byname-used.json).

Usage: .venv/bin/python tools/usebyname.py <data folder>
"""

import json
import os
import sys


def main(data):
    with open(os.path.join(data, "xc", "byname.json")) as f:
        found = [b for b in json.load(f) if b["xc"]]
    used = []
    for bird in found:
        xc_name = bird["xc"][0][0]
        with open(os.path.join(data, "xc", "byname", f"{bird['taxon']}.json")) as f:
            answer = json.load(f)
        recordings = [r for r in answer.get("recordings", []) if f"{r.get('gen')} {r.get('sp')}" == xc_name]
        path = os.path.join(data, "xc", "queries", f"{bird['taxon']}.json")
        with open(path) as f:
            kept = json.load(f)
        kept["answers"]["byname"] = {"recordings": recordings}
        with open(path, "w") as f:
            json.dump(kept, f)
        used.append({"taxon": bird["taxon"], "inaturalist": bird["inat"], "english": bird["en"],
                     "xeno-canto": xc_name, "recordings": len(recordings)})
    with open(os.path.join(data, "xc", "byname-used.json"), "w") as f:
        json.dump(used, f, indent=1)
    for u in used:
        print(f"{u['inaturalist']} -> {u['xeno-canto']} ({u['english']}, {u['recordings']} recordings)")


if __name__ == "__main__":
    main(sys.argv[1])
