# what3birdsongs · Aotearoa New Zealand

Every place in Aotearoa New Zealand gets three birds from those mapped there. Choose which birds sing, pick two places, and hear the trip between them.

*Preview: this README was written by Claude, Anthropic's AI model, while building the site. It has not yet been reviewed. This is an experimental build and is undergoing review.*

The New Zealand companion to [what3birdsongs](https://github.com/jethatch/what3birdsongs), which grew out of [what3chords songs](https://github.com/jethatch/what3chords-songs). It has the same design, with these differences:

- **The map** is drawn in NZTM2000 (EPSG:2193), New Zealand's own projection, with [OpenLayers](https://openlayers.org/) and LINZ's topographic basemap on its NZTM2000Quad tile grid. The Chatham Islands (Rēkohu/Wharekauri) sit in an inset. Everything about the basemap is in `js/basemap.js`, so it can later be swapped for a self-hosted PMTiles file on the same grid.
- **Which birds sing is a required choice:**
  - **Soundscape of settlement:** only birds introduced to New Zealand.
  - **All recorded birds:** every bird with a usable recording and a range map.
  - Links carry the choice (`s=settlement` or `s=all`).
- **Names:** birds are named in te reo Māori first, where iNaturalist has a Māori name, then in English.
- **Recordings:** recordings made in New Zealand are preferred.

## Running it

It is a static site with no build step. Serve the folder and open `index.html`.

The LINZ Basemaps key is read from `js/linz-key.js`:

```js
export const LINZ_KEY = "…";
```

It is a LINZ standard key, meant for use in web pages and therefore public. It expires after 90 days.

## The data

The data is built by the scripts in `tools/` from downloads kept outside the repository. Run them in this order:

1. **`ranges.py`:** for each H3 resolution-4 hexagon over the main islands, nearshore islands and the Chathams, finds which birds iNaturalist's range maps (geomodel) expect there. Range parts that circle the South Pole are settled by sightings (`poles.py`).
2. **`photos.py names|choose|download`:** gets te reo Māori and English names and a photo for each bird from iNaturalist.
3. **`status.py`:** decides which birds count as introduced, from iNaturalist's New Zealand lists. Five birds are on both its native and introduced lists; they were resolved by hand, as recorded in the script:
   - Mallard counts as introduced.
   - Takahē, white-winged tern, chestnut-breasted shelduck and curlew sandpiper count as native.
4. **`xenocanto.py search|choose|download`:** picks one recording per species, preferring New Zealand recordings.
5. **`clips.py`:** cuts a short clip from each recording.
6. **`build.py`:** writes `data/`, `audio/` and `img/birds/`, plus two files for review:
   - `library/species.json`: every species, and why any are missing;
   - `library/names.csv`: every name, for review.

### Known issues, for review

- **Birds not known here.** The range model also places about 200 species in New Zealand that aren't on iNaturalist's New Zealand lists, mostly North American and Australian birds, such as the Bald Eagle in Fiordland. They are kept for now, pending review, as the model has them, and are not part of the settlement set.
- **Te reo names** follow iNaturalist and are kept as they are for now. Some may differ from local usage: for example, iNaturalist's preferred Māori name for tūī is "Kōkō", a regional name, and song thrush has "Piopio", also the name of the extinct native thrush.
- **Species found under other names.** 14 species xeno-canto files under a different genus were matched by their English names and added (448 birds in all). They were accepted without being checked by hand; the list is in the build data (`xc/byname-used.json`).
- **Waves at sea.** Stops out at sea play one turn of a generic wave recording, "Ocean Waves on a Tropical Beach" by Jarrod Stanley (CC0, Wikimedia Commons). It was not made on these coasts: xeno-canto had no New Zealand surf recordings. The file page also names "J.D. Savanyu", so the attribution needs checking.
- **Disclaimer.** A first draft, written by Claude, is in "How it works", linked from the launch notice. It is to be reviewed and updated.
- **Basemap key.** The site uses a 90-day LINZ standard key, which is public by design, in `js/linz-key.js`. The basemap stops loading when the key expires, around late January 2027. The plan is to replace it with a self-hosted PMTiles basemap, which would also give a designed dark theme. The dark theme is currently LINZ's lighter style, dimmed with a CSS filter.
- **Taonga species** are included in "All recorded birds" as species only: names, modelled ranges and recordings. The site draws on no mātauranga Māori.

## Credits

- **Recordings:** from [xeno-canto](https://xeno-canto.org/), each under its recordist's licence.
- **Photos and range maps:** from [iNaturalist](https://www.inaturalist.org/).
- **Basemap:** © Toitū Te Whenua Land Information New Zealand, CC BY 4.0.
- **Original:** [what3chords](https://github.com/DOSull/what3chords) by David O'Sullivan, Luke Bergmann, Jim Thatcher and Nick Lally.
