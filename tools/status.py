"""Which birds count as introduced in New Zealand, for the "Soundscape of
settlement" set.

Asks iNaturalist for its New Zealand lists (place 6803) of introduced and of
native bird species, with research-grade or any observations, and keeps the
answers in <data>/inat/status/. Writes <data>/inat/status.json:

  {"introduced": [taxon ids], "native": [taxon ids], "neither": [...]}

for the species in <data>/ranges/species.json. A species on neither list
(a modelled range but no New Zealand listing) is left out of the settlement
set, and listed under "neither" for review.

Usage: .venv/bin/python tools/status.py <data folder>

One request at a time, 2.5 seconds apart, with the project's name and address.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.inaturalist.org/v1/observations/species_counts"
AGENT = "what3birdsongs-nz/0.1 (+https://github.com/jethatch)"
PAUSE = 2.5
NZ = 6803
BIRDS = 3

# Species on both lists, resolved by hand from where iNaturalist lists them
# (its full taxon records, 27 Oct 2026), and agreed with Jim Thatcher:
#   Mallard: introduced in seven NZ regions.
#   Takahē: endemic to the South Island; "introduced" only where it has
#     been moved to (North Island sanctuaries).
#   White-winged tern, chestnut-breasted shelduck, curlew sandpiper: every
#     visible NZ listing says native.
BOTH = {
    "Anas platyrhynchos": "introduced",
    "Porphyrio hochstetteri": "native",
    "Chlidonias leucopterus": "native",
    "Tadorna tadornoides": "native",
    "Calidris ferruginea": "native",
}

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


def listed(data, flag):
    """Every bird species on iNaturalist's New Zealand list with this flag."""
    folder = os.path.join(data, "inat", "status")
    os.makedirs(folder, exist_ok=True)
    ids = set()
    page = 1
    while True:
        path = os.path.join(folder, f"{flag}-{page}.json")
        if not os.path.exists(path):
            answer = fetch(f"{API}?place_id={NZ}&taxon_id={BIRDS}&{flag}=true&per_page=500&page={page}")
            with open(path, "w") as f:
                json.dump(answer, f)
        with open(path) as f:
            answer = json.load(f)
        ids |= {r["taxon"]["id"] for r in answer["results"] if r["taxon"]["rank"] == "species"}
        if page * 500 >= answer["total_results"]:
            return ids
        page += 1


def main(data):
    with open(os.path.join(data, "ranges", "species.json")) as f:
        species = json.load(f)
    introduced, native = listed(data, "introduced"), listed(data, "native")
    ours = {s["taxon"]: s["name"] for s in species}
    both = {t for t in ours if t in introduced and t in native}
    unresolved = sorted(ours[t] for t in both if ours[t] not in BOTH)
    if unresolved:
        sys.exit(f"On both lists and not yet resolved by hand: {', '.join(unresolved)}")
    counts_as = {t: BOTH[ours[t]] for t in both}
    out = {
        "introduced": sorted(t for t in ours if counts_as.get(t, "introduced" if t in introduced else None) == "introduced"),
        "native": sorted(t for t in ours if counts_as.get(t, "native" if t in native and t not in introduced else None) == "native"),
        "neither": sorted(t for t in ours if t not in introduced and t not in native),
        "both": sorted(both),
    }
    with open(os.path.join(data, "inat", "status.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(", ".join(f"{len(v)} {k}" for k, v in out.items()))
    for t in out["both"]:
        print(f"  on both lists, counted {counts_as[t]}: {ours[t]}")


if __name__ == "__main__":
    main(sys.argv[1])
