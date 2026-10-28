// Everything about the basemap, kept apart so it can be swapped: today
// LINZ's hosted topographic vector tiles, later perhaps a self-hosted PMTiles
// file on the same grid (through ol-pmtiles with a custom tileGrid).
//
// The map is drawn in NZTM2000 (EPSG:2193) on LINZ's NZTM2000Quad tile grid,
// as published in @linzjs/tile-matrix-set.

export const PROJECTION = "EPSG:2193";

proj4.defs(PROJECTION, "+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs");
ol.proj.proj4.register(proj4);

// The NZTM2000Quad grid: one 256-pixel tile at zoom 0, halving each level.
const QUAD_EXTENT = [-3260586.7284, 419435.9938, 6758167.443, 10438190.1652];
ol.proj.get(PROJECTION).setExtent(QUAD_EXTENT);
const RES0 = (QUAD_EXTENT[2] - QUAD_EXTENT[0]) / 256;
export const RESOLUTIONS = Array.from({ length: 22 }, (_, z) => RES0 / 2 ** z);

// LINZ has no dark style; the dark theme dims the lighter one with a CSS
// filter on the basemap's own canvas (see ":root[data-theme=\"dark\"] #map .ol-layer" in style.css).
const STYLES = {
  light: "topographic-v2",
  dark: "topolite-v2",
};
// The key is in js/linz-key.js (see README). Loaded lazily, so that
// without it only the basemap is missing, not the whole page.
let key = null;
async function styleUrl(theme) {
  if (!key) key = (await import("./linz-key.js")).LINZ_KEY;
  return `https://basemaps.linz.govt.nz/v1/styles/${STYLES[theme]}.json?api=${key}&tileMatrix=NZTM2000Quad`;
}

export const ATTRIBUTION = '© <a href="https://www.linz.govt.nz/" target="_blank" rel="noopener">Toitū Te Whenua LINZ</a> CC BY 4.0';

// Fills `group` (an ol.layer.Group at the bottom of the map) with the
// basemap's layers for this theme. Resolves once the style has loaded. If
// the theme changes again before then, the older result is dropped.
const fills = new WeakMap();
export async function fillBasemap(group, theme) {
  const ticket = (fills.get(group) || 0) + 1;
  fills.set(group, ticket);
  const fresh = new ol.layer.Group();
  await (olms.apply || olms.default)(fresh, await styleUrl(theme), { projection: PROJECTION, resolutions: RESOLUTIONS });
  if (fills.get(group) !== ticket) return;
  const layers = fresh.getLayers().getArray().slice();
  for (const layer of layers) {
    // olms names the sources' attributions after the style; use our own.
    const source = layer.getSource && layer.getSource();
    if (source && source.setAttributions) source.setAttributions(ATTRIBUTION);
  }
  fresh.getLayers().clear();
  group.getLayers().clear();
  group.getLayers().extend(layers);
}
