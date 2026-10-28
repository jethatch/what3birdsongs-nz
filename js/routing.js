// Building a route between two points as an ordered list of grid cells
// ("stops"). Two ways to get there:
//   hex walk - greedy local routing: from each cell step to whichever
//              neighbour is nearest the destination. No server involved.
//   roads    - ask the public OSRM server for a driving route and collect
//              the cells it passes through.
// Points are [lat, lng] throughout; GeoJSON-style [lng, lat] only appears in
// the `track` that the map draws.

const EARTH_RADIUS_KM = 6371.0088;
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving/";
const OSRM_TIMEOUT_MS = 15000;
const MAX_MERCATOR_LAT = 85.05;
const RAD = Math.PI / 180;

export function haversineKm(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLng = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function wrapLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

// Shift `lng` by whole turns so it is within 180 degrees of `reference`.
function unwrapLng(lng, reference) {
  return lng + Math.round((reference - lng) / 360) * 360;
}


// Points along the great circle from a to b, excluding a, including b.
function greatCircle(a, b) {
  const km = haversineKm(a, b);
  const n = Math.min(64, Math.ceil(km / 50));
  if (n <= 1) return [b];
  const toXyz = ([lat, lng]) => [
    Math.cos(lat * RAD) * Math.cos(lng * RAD),
    Math.cos(lat * RAD) * Math.sin(lng * RAD),
    Math.sin(lat * RAD),
  ];
  const p = toXyz(a);
  const q = toXyz(b);
  const angle = km / EARTH_RADIUS_KM;
  const points = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const wp = Math.sin((1 - t) * angle) / Math.sin(angle);
    const wq = Math.sin(t * angle) / Math.sin(angle);
    const v = [0, 1, 2].map((k) => wp * p[k] + wq * q[k]);
    points.push([Math.atan2(v[2], Math.hypot(v[0], v[1])) / RAD, Math.atan2(v[1], v[0]) / RAD]);
  }
  points.push(b);
  return points;
}

// ---------------------------------------------------------------------------
// Hex walk
// ---------------------------------------------------------------------------

// Greedy local routing over the cell grid at one resolution.
function walkCells(grid, start, end, res, maxCells) {
  const target = grid.cellAt(end[0], end[1], res);
  const targetCentre = grid.centre(target);
  let current = grid.cellAt(start[0], start[1], res);
  let remaining = haversineKm(grid.centre(current), targetCentre);
  const cells = [current];
  while (current !== target && cells.length <= maxCells) {
    let best = null;
    let bestKm = remaining;
    for (const neighbour of grid.neighbours(current)) {
      const km = neighbour === target ? 0 : haversineKm(grid.centre(neighbour), targetCentre);
      if (km < bestKm) {
        best = neighbour;
        bestKm = km;
      }
    }
    if (!best) {
      // No neighbour is closer (only possible where the grid is distorted);
      // let the grid finish the line, or jump if it can't.
      cells.push(...grid.lineTo(current, target));
      break;
    }
    cells.push(best);
    current = best;
    remaining = bestKm;
  }
  return cells;
}

export function buildWalkRoute(grid, start, end, maxStops) {
  const straightKm = haversineKm(start, end);
  // Finest resolution whose walk should fit, then coarsen if it doesn't
  // (a hex walk is up to ~15% longer than the straight line).
  let res = grid.maxRes;
  while (res > 0 && straightKm / grid.spacingKm(res) > maxStops - 1) res--;
  // The coarsest grid has to be walked to the end however long that takes.
  const limit = (r) => (r > 0 ? maxStops : 500);
  let cells = walkCells(grid, start, end, res, limit(res));
  while (cells.length > maxStops && res > 0) {
    res--;
    cells = walkCells(grid, start, end, res, limit(res));
  }

  const stops = cells.map((cell, i) => ({
    cell,
    point: i === 0 ? start : i === cells.length - 1 ? end : grid.centre(cell),
  }));
  // Start and end share a cell: still let the destination be heard.
  if (stops.length === 1 && straightKm > 0) stops.push({ cell: cells[0], point: end });

  const points = [stops[0].point];
  const stopAt = [0];
  for (let i = 1; i < stops.length; i++) {
    points.push(...greatCircle(stops[i - 1].point, stops[i].point));
    stopAt.push(points.length - 1);
  }
  const route = finishRoute({ grid, mode: "hex", res, stops, points, straightKm });
  stops.forEach((stop, i) => { stop.trackKm = route.cumKm[stopAt[i]]; });
  return route;
}

// ---------------------------------------------------------------------------
// Recorded path
// ---------------------------------------------------------------------------

// A route that was travelled rather than planned: `entries` are the places
// a live session stopped at, each { point: [lat, lng], res } with the
// cell size in use at the time.
export function buildPathRoute(grid, entries) {
  const stops = entries.map(({ point, res }) => ({ cell: grid.cellAt(point[0], point[1], res), point }));
  const points = [stops[0].point];
  const stopAt = [0];
  for (let i = 1; i < stops.length; i++) {
    points.push(...greatCircle(stops[i - 1].point, stops[i].point));
    stopAt.push(points.length - 1);
  }
  const straightKm = haversineKm(stops[0].point, stops[stops.length - 1].point);
  const route = finishRoute({ grid, mode: "path", res: entries[entries.length - 1].res, stops, points, straightKm });
  stops.forEach((stop, i) => { stop.trackKm = route.cumKm[stopAt[i]]; });
  return route;
}

// ---------------------------------------------------------------------------
// Road route
// ---------------------------------------------------------------------------

export class RoutingError extends Error {}

// Road geometry for the last few trips, so changing the song length or
// flipping between modes doesn't ask the server again.
const roadCache = new Map();

async function fetchRoad(start, end, signal) {
  const key = [...start, ...end].map((v) => v.toFixed(6)).join(",");
  if (roadCache.has(key)) return roadCache.get(key);
  const road = await requestRoad(start, end, signal);
  if (roadCache.size >= 8) roadCache.delete(roadCache.keys().next().value);
  roadCache.set(key, road);
  return road;
}

async function requestRoad(start, end, signal) {
  const straightKm = haversineKm(start, end);
  // Full geometry for a very long trip is megabytes of points we'd only
  // throw away again at the cell size such trips use.
  const overview = straightKm > 800 ? "simplified" : "full";
  const coords = `${start[1].toFixed(6)},${start[0].toFixed(6)};${end[1].toFixed(6)},${end[0].toFixed(6)}`;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), OSRM_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  if (signal) signal.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch(`${OSRM_URL}${coords}?overview=${overview}&geometries=geojson`, { signal: timeout.signal });
  } catch (error) {
    if (signal && signal.aborted) throw error;
    throw new RoutingError("the road routing server didn't answer");
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    // fall through to the status check
  }
  if (body && (body.code === "NoRoute" || body.code === "NoSegment")) {
    throw new RoutingError("there's no drivable route between these two places");
  }
  if (response.status === 429) throw new RoutingError("the road routing server is busy");
  if (!response.ok || !body || body.code !== "Ok" || !body.routes || !body.routes.length) {
    throw new RoutingError("the road routing server couldn't route this trip");
  }
  const line = body.routes[0].geometry.coordinates;
  if (!line || line.length < 2) throw new RoutingError("the road route came back empty");
  return line.map(([lng, lat]) => [lat, lng]);
}

// Stretches of the track inside one cell, in travel order.
function cellRuns(grid, points, cumKm, res) {
  const stepKm = grid.stepKm(res);
  const runs = [];
  const visit = (lat, lng, km) => {
    const cell = grid.cellAt(lat, wrapLng(lng), res);
    const last = runs[runs.length - 1];
    if (last && last.cell === cell) last.to = km;
    else runs.push({ cell, from: km, to: km });
  };
  for (let i = 0; i < points.length - 1; i++) {
    const segKm = cumKm[i + 1] - cumKm[i];
    const n = Math.max(1, Math.ceil(segKm / stepKm));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      visit(
        points[i][0] + (points[i + 1][0] - points[i][0]) * t,
        points[i][1] + (points[i + 1][1] - points[i][1]) * t,
        cumKm[i] + segKm * t,
      );
    }
  }
  const lastPoint = points[points.length - 1];
  visit(lastPoint[0], lastPoint[1], cumKm[cumKm.length - 1]);

  // A road that grazes a corner, or runs along an edge, flickers between
  // cells. Drop those slivers and rejoin what's left.
  const minKm = 0.12 * grid.spacingKm(res);
  const merged = [];
  runs.forEach((run, i) => {
    const sliver = i > 0 && i < runs.length - 1 && run.to - run.from < minKm;
    if (sliver) return;
    const last = merged[merged.length - 1];
    if (last && last.cell === run.cell) last.to = run.to;
    else merged.push({ ...run });
  });
  return merged;
}

export async function buildRoadRoute(grid, start, end, maxStops, signal) {
  const road = await fetchRoad(start, end, signal);
  const straightKm = haversineKm(start, end);
  // OSRM always snaps to the nearest road, even one an ocean away. A trip
  // that is mostly the jump to that road isn't a road trip.
  const snapKm = [haversineKm(start, road[0]), haversineKm(end, road[road.length - 1])];
  const snapLimitKm = Math.max(10, straightKm * 0.1);
  if (Math.max(...snapKm) > snapLimitKm) {
    const which = snapKm[0] >= snapKm[1] ? "start" : "end";
    throw new RoutingError(`the ${which} is ${Math.round(Math.max(...snapKm)).toLocaleString()} km from the nearest road`);
  }
  // Thin the geometry to a few thousand points; plenty for cells that
  // are never smaller than a 75th of the trip.
  const minGapKm = Math.max(0.0005, straightKm / 3000);
  const points = [start];
  const line = [...road, end];
  line.forEach((point, i) => {
    const previous = points[points.length - 1];
    const unwrapped = [point[0], unwrapLng(point[1], previous[1])];
    const gap = haversineKm(previous, unwrapped);
    if (gap > minGapKm || (i === line.length - 1 && gap > 0.0005)) points.push(unwrapped);
  });
  if (points.length < 2) return buildWalkRoute(grid, start, end, maxStops);

  const draft = finishRoute({ grid, mode: "road", res: 0, stops: [], points, straightKm });
  let res = grid.maxRes;
  while (res > 0 && draft.distanceKm / grid.spacingKm(res) > maxStops * 1.5) res--;
  let runs = cellRuns(grid, points, draft.cumKm, res);
  while (runs.length > maxStops && res > 0) {
    res--;
    runs = cellRuns(grid, points, draft.cumKm, res);
  }

  const stops = runs.map((run, i) => {
    const first = i === 0;
    const last = i === runs.length - 1;
    const trackKm = first ? 0 : last ? draft.distanceKm : (run.from + run.to) / 2;
    const at = first ? start : last ? end : pointAt(draft, trackKm);
    return { cell: run.cell, point: [at[0], wrapLng(at[1])], trackKm };
  });
  if (stops.length === 1) stops.push({ cell: stops[0].cell, point: end, trackKm: draft.distanceKm });

  const route = finishRoute({ grid, mode: "road", res, stops, points, straightKm });
  route.snapKm = snapKm;
  return route;
}

// ---------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------

// Web Mercator can't draw the last few degrees before the poles.
function clampLat(lat) {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

// Adds what the map and the playhead need: a continuous track (longitudes
// unwrapped so nothing jumps at the antimeridian) and the running distance
// along it in km.
function finishRoute({ grid, mode, res, stops, points, straightKm }) {
  const track = [];
  const cumKm = [0];
  points.forEach((point, i) => {
    const lng = i === 0 ? point[1] : unwrapLng(point[1], track[i - 1][0]);
    track.push([lng, clampLat(point[0])]);
    if (i > 0) cumKm.push(cumKm[i - 1] + haversineKm(points[i - 1], point));
  });
  return { grid, mode, res, stops, track, cumKm, straightKm, distanceKm: cumKm[cumKm.length - 1] };
}

function segmentAt(route, km) {
  const { cumKm } = route;
  const d = Math.max(0, Math.min(route.distanceKm, km));
  let lo = 0;
  let hi = cumKm.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumKm[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = cumKm[hi] - cumKm[lo];
  return { lo, hi, t: span > 0 ? (d - cumKm[lo]) / span : 0 };
}

// [lat, lng] at a distance along the track (lng is in the track's unwrapped frame).
export function pointAt(route, km) {
  if (route.track.length === 1) return [route.track[0][1], route.track[0][0]];
  const { lo, hi, t } = segmentAt(route, km);
  const a = route.track[lo];
  const b = route.track[hi];
  return [a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t];
}

// The part of the track already travelled at a distance along it, as
// [lng, lat] coordinates.
export function trackUpTo(route, km) {
  if (route.track.length < 2 || km <= 0) return [];
  const { lo } = segmentAt(route, km);
  const at = pointAt(route, km);
  return [...route.track.slice(0, lo + 1), [at[1], at[0]]];
}

// Cell outlines as GeoJSON, positioned on the same copy of the world as
// the track so they line up across the antimeridian.
export function stopsToGeoJSON(route) {
  const features = route.stops.map((stop, i) => {
    const centre = route.grid.centre(stop.cell);
    const anchor = pointAt(route, stop.trackKm)[1];
    const centreLng = unwrapLng(centre[1], anchor);
    let ring = route.grid.boundary(stop.cell).map(([lng, lat]) => [unwrapLng(lng, centreLng), clampLat(lat)]);
    const lngs = ring.map((vertex) => vertex[0]);
    if (Math.max(...lngs) - Math.min(...lngs) > 180) {
      // The cell sits on a pole. On this map that is everything beyond
      // its edge, right across the top (or bottom) of the world.
      const edge = clampLat(centre[0] > 0 ? 90 : -90);
      const sorted = ring.slice(0, -1).sort((p, q) => p[0] - q[0]);
      const around = [...sorted, [sorted[0][0] + 360, sorted[0][1]]];
      ring = [[around[0][0], edge], ...around, [around[around.length - 1][0], edge], [around[0][0], edge]];
    }
    return {
      type: "Feature",
      properties: { i },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
  });
  return { type: "FeatureCollection", features };
}
