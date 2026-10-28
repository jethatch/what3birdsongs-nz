// A song as a link. Everything needed to rebuild a trip and its sound lives
// in the URL hash, so a link can be shared with no server behind it.

import { GRIDS } from "./grid.js";
import { formatLatLng } from "./geocode.js";

const MODES = ["hex", "road"];
const LENGTHS = ["short", "medium", "long"];
const PACES = ["quick", "steady", "slow"];
const SETS = ["settlement", "all"];
const MAX_PATH_STOPS = 300;
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// ---------------------------------------------------------------------------
// Recorded paths: the encoded-polyline scheme (deltas of rounded
// coordinates, in 5-bit groups) with an alphabet that needs no escaping.
// ---------------------------------------------------------------------------

function encodeNumber(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += URL_SAFE[0x20 | (v & 0x1f)];
    v >>>= 5;
  }
  return out + URL_SAFE[v];
}

// entries: [{ point: [lat, lng], res }] -> { points, sizes } strings.
export function encodePath(entries) {
  // A very long session is thinned evenly so the link stays usable.
  const step = Math.ceil(entries.length / MAX_PATH_STOPS);
  const kept = entries.filter((_, i) => i % step === 0 || i === entries.length - 1);
  let points = "";
  let previous = [0, 0];
  const runs = [];
  for (const { point, res } of kept) {
    const rounded = [Math.round(point[0] * 1e5), Math.round(point[1] * 1e5)];
    points += encodeNumber(rounded[0] - previous[0]) + encodeNumber(rounded[1] - previous[1]);
    previous = rounded;
    const last = runs[runs.length - 1];
    if (last && last.res === res) last.count++;
    else runs.push({ res, count: 1 });
  }
  return { points, sizes: runs.map((run) => `${run.res.toString(36)}${run.count}`).join(".") };
}

// `maxRes` is the finest cell size the route's grid has.
export function decodePath(points, sizes, maxRes) {
  const numbers = [];
  let value = 0;
  let shift = 0;
  for (const ch of points) {
    const group = URL_SAFE.indexOf(ch);
    if (group < 0) return null;
    value |= (group & 0x1f) << shift;
    shift += 5;
    if (group < 0x20) {
      numbers.push(value & 1 ? ~(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  if (shift !== 0 || numbers.length < 2 || numbers.length % 2) return null;
  const count = numbers.length / 2;
  if (count > MAX_PATH_STOPS + 1) return null;
  // The sizes must account for exactly as many stops as there are points;
  // anything else is a damaged or hostile link, and not worth expanding.
  const resolutions = [];
  for (const run of (sizes || "").split(".")) {
    const match = run.match(/^([0-9a-z])(\d{1,4})$/);
    if (!match || parseInt(match[1], 36) > maxRes || resolutions.length + Number(match[2]) > count) return null;
    for (let i = 0; i < Number(match[2]); i++) resolutions.push(parseInt(match[1], 36));
  }
  if (resolutions.length !== count) return null;
  const entries = [];
  let lat = 0;
  let lng = 0;
  for (let i = 0; i < numbers.length; i += 2) {
    lat += numbers[i];
    lng += numbers[i + 1];
    const point = [lat / 1e5, lng / 1e5];
    const res = resolutions[i / 2];
    if (Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180) return null;
    entries.push({ point, res });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The whole state
// ---------------------------------------------------------------------------

// Settings only appear once they differ from the defaults, to keep links short.
export function encodeState(state, includePath) {
  const params = new URLSearchParams();
  // Which birds sing changes every address, so it always goes in.
  if (state.set) params.set("s", state.set);
  if (state.path) {
    if (includePath) {
      const { points, sizes } = encodePath(state.path);
      params.set("lv", points);
      params.set("lr", sizes);
    }
  } else {
    for (const [key, place] of [["a", state.start], ["b", state.end]]) {
      if (!place) continue;
      params.set(key, `${place.lat.toFixed(5)},${place.lng.toFixed(5)}`);
      params.set(`${key}n`, place.label);
    }
    if (state.mode !== "hex") params.set("m", state.mode);
    if (state.length !== "medium") params.set("l", state.length);
  }
  if (state.perStop !== 3) params.set("c", "1");
  if (state.pace !== "steady") params.set("pc", state.pace);
  return params.toString();
}

// Returns only the fields the hash sets, validated; anything odd is ignored.
export function decodeHash(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const found = {};
  const path = params.get("lv") ? decodePath(params.get("lv"), params.get("lr"), GRIDS.h3.maxRes) : null;
  if (path) {
    found.path = path;
  } else {
    for (const [key, which] of [["a", "start"], ["b", "end"]]) {
      const match = (params.get(key) || "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
      if (!match) continue;
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      found[which] = { lat, lng, label: (params.get(`${key}n`) || formatLatLng(lat, lng)).slice(0, 120) };
    }
    if (MODES.includes(params.get("m"))) found.mode = params.get("m");
    if (LENGTHS.includes(params.get("l"))) found.length = params.get("l");
  }
  if (SETS.includes(params.get("s"))) found.set = params.get("s");
  if (params.get("c") === "1") found.perStop = 1;
  if (PACES.includes(params.get("pc"))) found.pace = params.get("pc");
  return found;
}
