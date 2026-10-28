"""A photo, a te reo Māori name and an English name for every bird species,
from iNaturalist.

  names     asks the iNaturalist API about every species in
            <data>/ranges/species.json, 30 at a time, and keeps the answers
            in <data>/inat/taxa/
  choose    picks each species' photo: its default photo if that carries a
            Creative Commons licence, otherwise the first of its other photos
            that does (asking for the full taxon record only then), and
            writes <data>/inat/photos.json
  download  downloads the chosen photos, at iNaturalist's own "small" size
            and otherwise untouched, to <data>/inat/photos/

Usage: .venv/bin/python tools/photos.py names|choose|download <data folder>

One request at a time, a second apart, with the project's name and address.
"""

import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

API = "https://api.inaturalist.org/v1/taxa"
AGENT = "what3birdsongs-nz/0.1 (+https://github.com/jethatch)"
PAUSE = 2.5
LICENCES = {"cc0", "cc-by", "cc-by-nc", "cc-by-sa", "cc-by-nc-sa", "cc-by-nd", "cc-by-nc-nd"}

last_request = 0.0


def fetch(url, binary=False, tries=3):
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
            if error.code in (403, 429) or error.code >= 500:
                print(f"  server said {error.code}; waiting a minute", flush=True)
                time.sleep(60 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as error:
            print(f"  network trouble ({error}); waiting a minute", flush=True)
            time.sleep(60 * (attempt + 1))
    raise RuntimeError(f"gave up on {url}")


def species_list(data):
    with open(os.path.join(data, "ranges", "species.json")) as f:
        return json.load(f)


def names(data):
    folder = os.path.join(data, "inat", "taxa")
    os.makedirs(folder, exist_ok=True)
    ids = [bird["taxon"] for bird in species_list(data)]
    for start in range(0, len(ids), 30):
        batch = ids[start:start + 30]
        path = os.path.join(folder, f"batch-{start:05d}.json")
        if os.path.exists(path):
            continue
        # locale=mi gives the te reo Māori name where iNaturalist has one,
        # and english_common_name the English one.
        answer = fetch(f"{API}/{','.join(map(str, batch))}?locale=mi&preferred_place_id=6803&per_page=30")
        with open(path, "w") as f:
            json.dump(answer, f)
        print(f"{min(start + 30, len(ids))}/{len(ids)}", flush=True)


def photo_entry(photo):
    return {
        "id": photo["id"],
        "licence": photo.get("license_code"),
        "attribution": photo.get("attribution"),
        "url": photo["url"].replace("/square.", "/small."),
    }


def choose(data):
    folder = os.path.join(data, "inat", "taxa")
    taxa = {}
    for name in sorted(os.listdir(folder)):
        if name.startswith("batch-"):
            with open(os.path.join(folder, name)) as f:
                for taxon in json.load(f)["results"]:
                    taxa[taxon["id"]] = taxon
    out = []
    for bird in species_list(data):
        taxon = taxa.get(bird["taxon"])
        entry = {"taxon": bird["taxon"], "name": bird["name"]}
        if not taxon:
            out.append({**entry, "why": "not returned by iNaturalist"})
            continue
        entry["en"] = taxon.get("english_common_name")
        mi = taxon.get("preferred_common_name")
        if mi and mi != entry["en"]:
            entry["mi"] = mi
        entry["inat"] = f"https://www.inaturalist.org/taxa/{taxon['id']}"
        photo = taxon.get("default_photo")
        if not (photo and photo.get("license_code") in LICENCES):
            # The default photo isn't openly licensed: look through the rest.
            path = os.path.join(folder, f"taxon-{bird['taxon']}.json")
            if not os.path.exists(path):
                with open(path, "w") as f:
                    json.dump(fetch(f"{API}/{bird['taxon']}?locale=en"), f)
            with open(path) as f:
                full = json.load(f)["results"][0]
            photo = next((tp["photo"] for tp in full.get("taxon_photos", [])
                          if tp["photo"].get("license_code") in LICENCES), None)
        if photo:
            entry["photo"] = photo_entry(photo)
        else:
            entry["why"] = "no openly licensed photo"
        out.append(entry)
    with open(os.path.join(data, "inat", "photos.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(f"{sum(1 for e in out if 'photo' in e)} of {len(out)} species have a photo")


def download(data):
    folder = os.path.join(data, "inat", "photos")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(data, "inat", "photos.json")) as f:
        entries = json.load(f)
    # Photos already downloaded for the North American site are reused when
    # iNaturalist still picks the same photo, rather than fetched again.
    na = "/Users/thatchja/what3birdsongs-data/inat"
    na_ids = {}
    if os.path.exists(os.path.join(na, "photos.json")):
        with open(os.path.join(na, "photos.json")) as f:
            na_ids = {e["taxon"]: e["photo"]["id"] for e in json.load(f) if "photo" in e}
    for n, entry in enumerate(entries):
        if "photo" not in entry:
            continue
        extension = os.path.splitext(entry["photo"]["url"].split("?")[0])[1].lower() or ".jpg"
        path = os.path.join(folder, f"{entry['taxon']}{extension}")
        if os.path.exists(path):
            continue
        cached = os.path.join(na, "photos", f"{entry['taxon']}{extension}")
        if na_ids.get(entry["taxon"]) == entry["photo"]["id"] and os.path.exists(cached):
            shutil.copyfile(cached, path)
            continue
        body = fetch(entry["photo"]["url"], binary=True)
        with open(path, "wb") as f:
            f.write(body)
        print(f"{n + 1}/{len(entries)} {entry['name']} {len(body) // 1024} KB", flush=True)


if __name__ == "__main__":
    {"names": names, "choose": choose, "download": download}[sys.argv[1]](sys.argv[2])
