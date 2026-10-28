// A place's three birds.
//
// The catalogue (data/birds.json) lists every bird with a recording, in a
// fixed order. The range tiles (data/ranges/*.json) say, for each H3
// resolution-4 hexagon in the area (about 1,770 km²), which of those birds
// are expected there, according to iNaturalist's range maps.
//
// A place's address is the finer part of its resolution-15 hexagon: the
// eleven base-7 digits that say where it is inside its resolution-4
// hexagon, dealt out coarse, middling, fine, coarse... (as what3chords
// does) so that neighbouring places don't share most of their birds. That
// number is stretched evenly over every way of picking three different
// birds from the local list, in order, and read as three picks.
//
// A stop on a route is a coarser hexagon. It plays the birds of one spot
// inside it, picked by the hexagon's own ID (see spotIn).
//
// Which birds count is the visitor's choice (setBirdSet): every recorded
// bird, or only those introduced to New Zealand ("settlement"). The local
// list, and so every address, depends on that choice.

import { ADDRESS_RES } from "./grid.js";

const LOCAL_RES = 4;
const LOCAL_DIGITS = ADDRESS_RES - LOCAL_RES;
const LOCAL_BOUND = 7n ** BigInt(LOCAL_DIGITS);

let catalogue = null; // { version, birds, tiles: Set, tileRes }
let birdSet = null; // null until chosen | "settlement" | "all"
export const BIRD_SETS = ["settlement", "all"];
const tiles = new Map(); // tile cell -> Promise<{ cell: Uint8Array bitset }>
const loaded = new Map(); // tile cell -> { cell: bitset } once arrived

// Where digit i goes when `count` digits are dealt out coarse, middling,
// fine, coarse, middling, fine... A count that doesn't divide by three
// leaves its last one or two where they are.
function dealt(count) {
  const each = Math.floor(count / 3);
  const positions = [];
  for (let i = 0; i < count; i++) positions.push(i < each * 3 ? (i % 3) * each + Math.floor(i / 3) : i);
  return positions;
}
const DEAL = dealt(LOCAL_DIGITS);

export async function loadBirds(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("The list of birds didn’t load. Check your connection and reload.");
  const data = await response.json();
  const base = new URL(".", new URL(url, location.href));
  const birds = data.birds.map((bird, index) => ({
    ...bird,
    index,
    clip: new URL(bird.clip, base).href,
    photo: bird.photo ? new URL(bird.photo, base).href : null,
  }));
  catalogue = { ...data, birds, tiles: new Set(data.tiles), base };
  return catalogue;
}

export function catalogueInfo() {
  return catalogue;
}

export function setBirdSet(id) {
  birdSet = BIRD_SETS.includes(id) ? id : null;
}

function tileOf(cell4) {
  return h3.cellToParent(cell4, catalogue.tileRes);
}

function decodeBits(text) {
  const raw = atob(text);
  const bits = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bits[i] = raw.charCodeAt(i);
  return bits;
}

function loadTile(tile) {
  if (!tiles.has(tile)) {
    const loading = fetch(new URL(`ranges/${tile}.json`, catalogue.base)).then(async (response) => {
      if (!response.ok) throw new Error(`Range tile ${tile} didn’t load (${response.status}).`);
      const raw = await response.json();
      const cells = {};
      for (const [cell, text] of Object.entries(raw)) cells[cell] = decodeBits(text);
      loaded.set(tile, cells);
      return cells;
    });
    loading.catch(() => tiles.delete(tile));
    tiles.set(tile, loading);
  }
  return tiles.get(tile);
}

// Fetches whatever range tiles these points need. Points outside the area
// need none.
export function prepareBirds(points) {
  return prepareCells(points.map(([lat, lng]) => h3.latLngToCell(lat, lng, LOCAL_RES)));
}

// The same for cells of resolution 4 or finer.
export async function prepareCells(cells) {
  const wanted = new Set();
  for (const cell of cells) {
    const tile = tileOf(h3.cellToParent(cell, LOCAL_RES));
    if (catalogue.tiles.has(tile)) wanted.add(tile);
  }
  await Promise.all([...wanted].map(loadTile));
}

// The birds of the chosen set expected in a resolution-4 hexagon, in
// catalogue order, or null when it's outside the area (or its tile hasn't
// been fetched, or no set is chosen yet).
function localBirds(cell4) {
  const cells = loaded.get(tileOf(cell4));
  const bits = cells && cells[cell4];
  if (!bits || !birdSet) return null;
  const keep = birdSet === "settlement" ? (bird) => bird.introduced : () => true;
  const list = [];
  for (let byte = 0; byte < bits.length; byte++) {
    if (!bits[byte]) continue;
    for (let bit = 0; bit < 8; bit++) {
      if (bits[byte] & (128 >> bit)) {
        const index = byte * 8 + bit;
        if (index < catalogue.birds.length && keep(catalogue.birds[index])) list.push(catalogue.birds[index]);
      }
    }
  }
  return list;
}

// Whether a cell (resolution 4 or finer) is inside the mapped area, once
// prepareCells() has fetched its tile. Outside it is out at sea (or beyond
// the area's land).
export function inArea(cell) {
  const cell4 = h3.cellToParent(cell, LOCAL_RES);
  const tile = tileOf(cell4);
  if (!catalogue.tiles.has(tile)) return false;
  const cells = loaded.get(tile);
  return Boolean(cells && cells[cell4]);
}

// The place's number within its resolution-4 hexagon: below LOCAL_BOUND.
function localNumber(cell15) {
  const bits = BigInt("0x" + cell15);
  const digits = new Array(LOCAL_DIGITS);
  for (let i = 0; i < LOCAL_DIGITS; i++) {
    const res = LOCAL_RES + 1 + i;
    digits[DEAL[i]] = (bits >> BigInt(3 * (ADDRESS_RES - res))) & 7n;
  }
  let n = 0n;
  for (const digit of digits) n = n * 7n + digit;
  return n;
}

// A 53-bit hash of a string (cyrb53), for picking a spot inside a cell.
function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// The spot that stands for a whole cell of a route: one of its finest
// cells, picked by the cell's own ID, so every visit and every link gets the
// same one. (The cell's centre won't do: its finer digits are all zero, so
// every stop would share the same few birds.)
export function spotIn(cell) {
  if (h3.getResolution(cell) >= ADDRESS_RES) return cell;
  const size = h3.cellToChildrenSize(cell, ADDRESS_RES);
  return h3.childPosToCell(hash(cell) % size, cell, ADDRESS_RES);
}

// A place's three birds, synchronously, once prepareBirds() has fetched its
// tile: { birds: [three], local: how many birds the hexagon has } or null.
export function birdsFor(lat, lng) {
  return birdsAt(h3.latLngToCell(lat, lng, ADDRESS_RES));
}

// The same for a finest-level cell.
export function birdsAt(cell15) {
  const list = localBirds(h3.cellToParent(cell15, LOCAL_RES));
  if (!list || list.length < 3) return null;
  const k = BigInt(list.length);
  const ways = k * (k - 1n) * (k - 2n);
  let n = (localNumber(cell15) * ways) / LOCAL_BOUND;
  const pool = list.slice();
  const birds = [];
  for (const size of [(k - 1n) * (k - 2n), k - 2n, 1n]) {
    const pick = Number(n / size);
    n %= size;
    birds.push(pool.splice(pick, 1)[0]);
  }
  return { birds, local: list.length };
}
