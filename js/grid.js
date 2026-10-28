// The grid places are addressed on: Uber's H3 hexagons, as in what3chords.
// Routes are chains of hexagons; birds.js turns a hexagon into three birds.
//
// Points are [lat, lng]; cell outlines are GeoJSON-style [lng, lat] rings.

export const ADDRESS_RES = 15;

const h3Grid = {
  id: "h3",
  name: "Hexagons (H3)",
  cell: "hexagon",
  cells: "hexagons",
  walk: "Hex walk",
  maxRes: ADDRESS_RES,
  // Cell sizes for a live session: on foot, on a bike, driving in town, driving.
  liveRes: [11, 10, 9, 8],

  cellAt: (lat, lng, res) => h3.latLngToCell(lat, lng, res),
  centre: (cell) => h3.cellToLatLng(cell),
  boundary: (cell) => h3.cellToBoundary(cell, true),
  neighbours: (cell) => h3.gridDisk(cell, 1).filter((other) => other !== cell),
  // Centre-to-centre distance between neighbouring cells.
  spacingKm: (res) => Math.sqrt(3) * h3.getHexagonEdgeLengthAvg(res, "km"),
  // How finely to sample a road when collecting the cells it passes through.
  stepKm: (res) => h3.getHexagonEdgeLengthAvg(res, "km") / 3,
  // Used only if a greedy walk gets stuck, which can happen where the grid
  // is distorted around one of its twelve pentagons.
  lineTo(from, to) {
    try {
      return h3.gridPathCells(from, to).slice(1);
    } catch (error) {
      return [to];
    }
  },
};

export const GRIDS = { h3: h3Grid };
