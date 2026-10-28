"""Which birds are expected in each part of Aotearoa New Zealand: the main
islands, Stewart Island/Rakiura and the nearshore islands, and the Chatham
Islands (Rēkohu/Wharekauri). Not the subantarctic islands, the Kermadecs or
Tokelau.

Reads iNaturalist's open range maps (the "geomodel", one multipolygon per
species, drawn from H3 resolution-4 hexagons) and Natural Earth's country
outlines, and writes:

  <data>/ranges/region.json   the resolution-4 hexagons that make up the area
  <data>/ranges/species.json  every bird species expected somewhere in it,
                              with the number of hexagons it is expected in
  <data>/ranges/cells.json    hexagon -> the taxon ids of the birds expected

Usage: .venv/bin/python tools/ranges.py <data folder>

The data folder holds the downloads and is kept out of the repository:
  inat/iNaturalist_geomodel_Aves_*.gpkg  from s3://inaturalist-open-data/geomodel/geopackages/latest/
  ne/countries50.geojson                 Natural Earth 1:50m admin-0 countries
  inat/sightings/<taxon>.json            (from tools/poles.py) sightings of
                                         the species whose ranges circle a pole
"""

import glob
import json
import os
import sqlite3
import struct
import sys

import h3
import numpy as np
import shapely
from shapely.geometry import shape

RES = 4
COUNTRIES = {"New Zealand"}


def region_shape(path):
    """The islands in the area, as one shapely geometry."""
    with open(path, encoding="utf-8") as f:
        features = json.load(f)["features"]
    parts = []
    for feature in features:
        if feature["properties"].get("ADMIN") not in COUNTRIES:
            continue
        geometry = shape(feature["geometry"])
        polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
        for polygon in polygons:
            centre = polygon.representative_point()
            mainland = 166 <= centre.x <= 179 and -48 < centre.y < -33.9
            chathams = -177.5 <= centre.x <= -175.5 and -45 < centre.y < -43
            if not (mainland or chathams):
                continue
            parts.append(polygon)
    return shapely.union_all(parts)


def region_cells(region):
    """Every resolution-4 hexagon that touches the area, so coasts and
    borders aren't left silent."""
    cells = set()
    polygons = list(region.geoms) if region.geom_type == "MultiPolygon" else [region]
    for polygon in polygons:
        cells |= set(h3.h3shape_to_cells_experimental(h3.geo_to_h3shape(polygon), RES, contain="overlap"))
    return sorted(cells)


def gpkg_geometry(blob):
    """A GeoPackage geometry blob: a small header, an optional envelope, then WKB."""
    flags = blob[3]
    envelope = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    return shapely.from_wkb(blob[8 + envelope:])


def unit_vectors(lngs, lats):
    lng, lat = np.radians(lngs), np.radians(lats)
    return np.column_stack([np.cos(lat) * np.cos(lng), np.cos(lat) * np.sin(lng), np.sin(lat)])


def turning(ring, points):
    """For each point (unit vectors), how far the ring turns around it as
    seen from that point, on the sphere: about +2 pi when the ring goes
    counter-clockwise round the point, 0 or -2 pi otherwise. Edges are taken
    as great-circle arcs, which for hexagon edges of 25 km is exact enough."""
    xy = np.asarray(ring.coords)
    v = unit_vectors(xy[:, 0], xy[:, 1])
    a, b = v[:-1], v[1:]
    total = np.zeros(len(points))
    for start in range(0, len(a), 2000):
        aa, bb = a[start:start + 2000], b[start:start + 2000]
        across = np.cross(aa, bb) @ points.T
        along = (aa * bb).sum(1)[:, None] - (aa @ points.T) * (bb @ points.T)
        total += np.arctan2(across, along).sum(0)
    return total


def jumps(ring):
    return bool(np.any(np.abs(np.diff(np.asarray(ring.coords)[:, 0])) > 180))


def covered(geometry, lngs, lats, decide):
    """Which points the range covers.

    The files store each range as flat longitude-latitude polygons. That is
    right for nearly every part, and those parts are tested as stored. But
    for 27 species a part goes all the way round a pole (birds whose range
    rings the Arctic across the Bering Strait, and some southern seabirds),
    and the exporter closed its outline by a detour down the 180th meridian
    to the opposite pole and back. Such an outline divides the globe in two,
    and the file doesn't reliably say which side is the range: read flat, Snow
    Petrel covers almost all of North America; read the other way, Bank
    Swallow covers almost none. For those parts, the two sides are found on
    the sphere (by how far the outline turns around each point), and
    `decide(part_index, plus, minus)` picks the side holding more of the
    species' iNaturalist sightings in the area, or neither if there are
    almost none (see tools/poles.py)."""
    parts = list(geometry.geoms) if hasattr(geometry, "geoms") else [geometry]
    inside = np.zeros(len(lngs), dtype=bool)
    plain = [p for p in parts if not any(jumps(r) for r in [p.exterior, *p.interiors])]
    if plain:
        union = shapely.union_all(plain) if len(plain) > 1 else plain[0]
        shapely.prepare(union)
        inside |= shapely.contains_xy(union, lngs, lats)
    points = None
    for index, part in enumerate(parts):
        if part in plain:
            continue
        if points is None:
            points = unit_vectors(lngs, lats)
        total = sum(turning(ring, points) for ring in [part.exterior, *part.interiors])
        plus, minus = total > 0, total <= 0
        side = decide(index, plus, minus)
        if side == "+":
            inside |= plus
        elif side == "-":
            inside |= minus
        # "0": neither side; the bird isn't seen near this part at all.
    return inside


def main(data):
    out = os.path.join(data, "ranges")
    os.makedirs(out, exist_ok=True)

    region = region_shape(os.path.join(data, "ne", "countries50.geojson"))
    cells = region_cells(region)
    print(f"{len(cells)} resolution-{RES} hexagons in the area")
    lats, lngs = np.array([h3.cell_to_latlng(c) for c in cells]).T
    # The area crosses the 180th meridian (the Chathams), so only latitude
    # is used to skip ranges that are clearly elsewhere.
    south, north = region.bounds[1], region.bounds[3]

    expected = {cell: [] for cell in cells}
    species = []
    versions = set()
    index_of = {cell: i for i, cell in enumerate(cells)}
    questions = []
    decisions = []

    def sightings_in_area(taxon_id):
        """Which of the area's hexagons have iNaturalist sightings of a
        species (from tools/poles.py), or None if not fetched yet."""
        path = os.path.join(data, "inat", "sightings", f"{taxon_id}.json")
        if not os.path.exists(path):
            return None
        seen = np.zeros(len(cells), dtype=bool)
        for lat, lng in json.load(open(path)):
            i = index_of.get(h3.latlng_to_cell(lat, lng, RES))
            if i is not None:
                seen[i] = True
        return seen

    for path in sorted(glob.glob(os.path.join(data, "inat", "iNaturalist_geomodel_Aves_*.gpkg"))):
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        table = db.execute("select table_name from gpkg_contents").fetchone()[0]
        rows = db.execute(f'select taxon_id, name, rank, geomodel_version, geom from "{table}"')
        for taxon_id, name, rank, version, blob in rows:
            if rank != "species" or blob is None:
                continue
            geometry = gpkg_geometry(blob)
            gw, gs, ge, gn = geometry.bounds
            if gn < south or gs > north:
                continue
            def decide(index, plus, minus, taxon_id=taxon_id, name=name):
                seen = sightings_in_area(taxon_id)
                if seen is None:
                    questions.append({"taxon": taxon_id, "name": name})
                    return "0"
                on_plus, on_minus = int((seen & plus).sum()), int((seen & minus).sum())
                choice = "0" if on_plus + on_minus < 3 else "+" if on_plus >= on_minus else "-"
                decisions.append(f"{name}: hexagons with sightings on the + side {on_plus}, - side {on_minus} -> {choice} "
                                 f"({int(plus.sum()) if choice == '+' else int(minus.sum()) if choice == '-' else 0} hexagons)")
                return choice

            # The range is made of whole hexagons, so a hexagon is in it
            # exactly when its centre is.
            inside = covered(geometry, lngs, lats, decide)
            count = int(inside.sum())
            if not count:
                continue
            versions.add(version)
            species.append({"taxon": taxon_id, "name": name, "cells": count})
            for i in np.nonzero(inside)[0]:
                expected[cells[i]].append(taxon_id)
        db.close()

    species.sort(key=lambda s: s["name"])
    empty = sum(1 for v in expected.values() if not v)
    print(f"{len(species)} species; geomodel version(s) {sorted(versions)}; {empty} hexagons with no birds")
    with open(os.path.join(out, "pole_questions.json"), "w") as f:
        json.dump(questions, f, indent=1)
    with open(os.path.join(out, "pole_decisions.txt"), "w") as f:
        f.write("\n".join(decisions) + "\n")
    if questions:
        print(f"{len(questions)} pole-circling range parts need sightings: run tools/poles.py, then this again")
    with open(os.path.join(out, "region.json"), "w") as f:
        json.dump({"res": RES, "cells": cells, "geomodel": sorted(versions)}, f)
    with open(os.path.join(out, "species.json"), "w") as f:
        json.dump(species, f, indent=0)
    with open(os.path.join(out, "cells.json"), "w") as f:
        json.dump(expected, f)


if __name__ == "__main__":
    main(sys.argv[1])
