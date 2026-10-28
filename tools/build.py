"""Puts the site's bird data together from the downloads.

Reads, from the data folder:
  ranges/species.json, ranges/cells.json   (tools/ranges.py)
  xc/chosen.json, xc/unmatched.json        (tools/xenocanto.py choose)
  clips/clips.json, clips/*.mp3            (tools/clips.py)
  inat/photos.json, inat/photos/*          (tools/photos.py)
  inat/status.json                         (tools/status.py)

Writes, in the repository:
  audio/<taxon>.mp3          the clips
  img/birds/<taxon>.<ext>    the photos, as iNaturalist served them
  data/birds.json            the catalogue: every bird with a clip, in a
                             fixed order (by iNaturalist taxon id)
  data/ranges/<tile>.json    for each H3 resolution-2 tile, its
                             resolution-4 hexagons and, as a bitset over
                             the catalogue, the birds expected in each
  library/species.json       every species in range, and whether it made
                             it in, and if not, why: for sorting out later
  library/names.csv          every bird's te reo Māori and English names,
                             for review

Usage: .venv/bin/python tools/build.py <data folder> <repository>
"""

import base64
import csv
import json
import re
import os
import shutil
import sys
from collections import defaultdict

import h3
from PIL import Image

VERSION = "1.0"
TILE_RES = 2
PHOTO_SIZE = 240  # pixels, longest side
PHOTO_QUALITY = 70


def copy_photo(source, target_stem, licence):
    """A photo for the page. "No derivatives" photos are copied exactly as
    iNaturalist serves them; the rest are re-saved smaller, to keep the site
    small. Returns the file name used."""
    if "nd" in (licence or ""):
        target = target_stem + os.path.splitext(source)[1].lower()
        shutil.copyfile(source, target)
        return os.path.basename(target)
    image = Image.open(source).convert("RGB")
    image.thumbnail((PHOTO_SIZE, PHOTO_SIZE))
    image.save(target_stem + ".jpg", "JPEG", quality=PHOTO_QUALITY, optimize=True, progressive=True)
    return os.path.basename(target_stem) + ".jpg"


def names_of(photo, sci):
    """(te reo Māori name or None, English name). iNaturalist's New Zealand
    English names are sometimes both at once, "Warou (Welcome Swallow)";
    those are split."""
    en = photo.get("en") or sci
    mi = photo.get("mi")
    both = re.fullmatch(r"(.+?) \((.+)\)", en)
    if both:
        mi, en = mi or both.group(1), both.group(2)
    return (mi if mi and mi != en else None), en


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def licence_code(url):
    """https://creativecommons.org/licenses/by-nc-sa/4.0/ -> by-nc-sa 4.0"""
    parts = [p for p in (url or "").split("/") if p]
    if "licenses" in parts:
        i = parts.index("licenses")
        return " ".join(parts[i + 1:i + 3])
    if "publicdomain" in parts:
        return "cc0"
    return url or ""


def main(data, repo):
    species = load(os.path.join(data, "ranges", "species.json"))
    cells = load(os.path.join(data, "ranges", "cells.json"))
    region = load(os.path.join(data, "ranges", "region.json"))
    chosen = {b["taxon"]: b for b in load(os.path.join(data, "xc", "chosen.json"))}
    unmatched = {b["taxon"]: b for b in load(os.path.join(data, "xc", "unmatched.json"))}
    clips = load(os.path.join(data, "clips", "clips.json"))
    photos = {p["taxon"]: p for p in load(os.path.join(data, "inat", "photos.json"))}
    photo_files = {int(os.path.splitext(f)[0]): f for f in os.listdir(os.path.join(data, "inat", "photos"))}
    introduced = set(load(os.path.join(data, "inat", "status.json"))["introduced"])

    audio_dir = os.path.join(repo, "audio")
    image_dir = os.path.join(repo, "img", "birds")
    for folder in (audio_dir, image_dir, os.path.join(repo, "data", "ranges"), os.path.join(repo, "library")):
        os.makedirs(folder, exist_ok=True)

    library = []
    birds = []
    for bird in sorted(species, key=lambda b: b["taxon"]):
        taxon = bird["taxon"]
        rec = chosen.get(taxon)
        clip = clips.get(str(taxon))
        photo = photos.get(taxon, {})
        mi, en = names_of(photo, bird["name"])
        status = {"taxon": taxon, "name": bird["name"], "mi": mi, "en": en, "introduced": taxon in introduced, "hexagons": bird["cells"]}
        if not rec:
            status["why"] = unmatched.get(taxon, {}).get("why", "no recording chosen")
        elif not clip or clip.get("xc") != rec["xc"]:
            status["why"] = "recording not downloaded or not cut yet"
        library.append(status)
        if "why" in status:
            continue
        shutil.copyfile(os.path.join(data, "clips", f"{taxon}.mp3"), os.path.join(audio_dir, f"{taxon}.mp3"))
        entry = {
            "taxon": taxon,
            "name": en,
            "mi": mi,
            "sci": bird["name"],
            "introduced": taxon in introduced,
            "clip": f"../audio/{taxon}.mp3",
            "rec": {
                "xc": rec["xc"],
                "by": rec.get("rec"),
                "lic": licence_code(rec.get("lic")),
                "licUrl": rec.get("lic"),
                "type": rec.get("type"),
                "where": rec.get("cnt"),
                "sono": rec.get("sono"),
                "at": clip.get("start"),
            },
        }
        if taxon in photo_files and photo.get("photo"):
            name = copy_photo(os.path.join(data, "inat", "photos", photo_files[taxon]),
                              os.path.join(image_dir, str(taxon)), photo["photo"].get("licence"))
            entry["photo"] = f"../img/birds/{name}"
            entry["photoBy"] = photo["photo"].get("attribution")
            entry["photoLic"] = photo["photo"].get("licence")
            entry["inat"] = photo.get("inat")
        birds.append(entry)

    index = {b["taxon"]: i for i, b in enumerate(birds)}
    size = (len(birds) + 7) // 8
    tiles = defaultdict(dict)
    for cell, taxa in cells.items():
        bits = bytearray(size)
        for taxon in taxa:
            i = index.get(taxon)
            if i is not None:
                bits[i // 8] |= 128 >> (i % 8)
        tiles[h3.cell_to_parent(cell, TILE_RES)][cell] = base64.b64encode(bytes(bits)).decode()
    ranges_dir = os.path.join(repo, "data", "ranges")
    for name in os.listdir(ranges_dir):
        os.remove(os.path.join(ranges_dir, name))
    for tile, content in tiles.items():
        with open(os.path.join(ranges_dir, f"{tile}.json"), "w") as f:
            json.dump(content, f, separators=(",", ":"))

    with open(os.path.join(repo, "data", "birds.json"), "w", encoding="utf-8") as f:
        json.dump({
            "version": VERSION,
            "geomodel": region.get("geomodel"),
            "tileRes": TILE_RES,
            "tiles": sorted(tiles),
            "missing": sum(1 for s in library if "why" in s),
            "birds": birds,
        }, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(repo, "library", "species.json"), "w", encoding="utf-8") as f:
        json.dump(library, f, ensure_ascii=False, indent=1)
    with open(os.path.join(repo, "library", "names.csv"), "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["scientific", "te reo Māori (iNaturalist)", "English", "introduced", "in the site"])
        for s in sorted(library, key=lambda s: s["name"]):
            writer.writerow([s["name"], s["mi"] or "", s["en"], "yes" if s["introduced"] else "", "" if "why" in s else "yes"])
    missing = sum(1 for s in library if "why" in s)
    print(f"{len(birds)} birds in the catalogue, {missing} species set aside; {len(tiles)} range tiles")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
