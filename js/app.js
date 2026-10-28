import { geocode, formatLatLng } from "./geocode.js";
import {
  buildWalkRoute, buildRoadRoute, buildPathRoute, RoutingError, pointAt, trackUpTo,
  stopsToGeoJSON, wrapLng,
} from "./routing.js";
import { GRIDS } from "./grid.js";
import { loadBirds, prepareBirds, prepareCells, birdsFor, birdsAt, spotIn, catalogueInfo, setBirdSet } from "./birds.js";
import { Aviary, Player, LiveRecorder, renderSong, songSeconds } from "./audio.js";
import { combine, licenceName, licenceUrl } from "./licences.js";
import { LiveSession, liveSupport, paceName } from "./live.js";
import { encodeState, decodeHash } from "./link.js";
import { createMapView } from "./mapview.js";

// Route colours live here rather than in CSS because the map is drawn on a canvas.
const MAP_COLOURS = {
  dark: { hex: "#a9c79b", hexOpacity: 0.12, played: "#e0876a", current: "#a9c79b", track: "rgba(255,255,255,0.6)", casing: "#0c0f0d" },
  light: { hex: "#2f4a2c", hexOpacity: 0.08, played: "#b8553a", current: "#93b483", track: "rgba(20,26,20,0.55)", casing: "#fbfcf8" },
};
// How close the map comes for a place: about 115 m a pixel, a town's width.
const PLACE_METRES_PER_PIXEL = 115;
const LENGTHS = {
  short: { name: "Short", stops: 10, explain: "About 10 stops at most. Big hexagons, a quick sketch of the trip." },
  medium: { name: "Medium", stops: 28, explain: "About 28 stops at most. A proper song." },
  long: { name: "Long", stops: 75, explain: "About 75 stops at most. Small hexagons, the album version." },
};
const MODES = {
  hex: { explain: "Greedy local routing: from each hexagon, step to whichever neighbour is nearest the destination. Worked out in your browser, and it ignores roads, rivers and lakes." },
  road: { explain: "Asks the public OSRM server for a driving route and plays the hexagons it passes through. If no road connects the two places, or either pin is far from any road, you get the hex walk instead." },
};
// Jim Thatcher's wording.
const SET_EXPLAIN = {
  settlement: "Only birds brought here through colonisation and trade. Birds considered native have been withheld; what remains is a soundscape of settlement.",
  all: "Every bird with a usable recording on xeno-canto and a range map from iNaturalist: native and introduced alike. A fuller reflection of what might be heard in each area.",
  none: "Choose one to begin: nothing plays until you do.",
};
const NEED_SET = "First choose which birds sing, in section 1.";
const PER_STOP_EXPLAIN = {
  3: "Each stop’s three birds sing one after another: the full address of every place you pass.",
  1: "Each stop’s three birds sing at once, a small dawn chorus, so the trip moves three times as fast.",
};
const PACES = {
  quick: { name: "Quick", seconds: 3, explain: "Each turn lasts 3 seconds: a snatch of each song." },
  steady: { name: "Steady", seconds: 4.5, explain: "Each turn lasts 4½ seconds." },
  slow: { name: "Slow", seconds: 6, explain: "Each turn lasts 6 seconds, the whole of each clip." },
};
const EXAMPLE = {
  start: { lat: -41.28664, lng: 174.77557, label: "Te Whanganui-a-Tara Wellington" },
  end: { lat: -39.49278, lng: 176.91222, label: "Ahuriri Napier" },
};
const SECTIONS = ["more-route"];
const QUIET = "No birds here: beyond the islands this map covers, or out at sea.";

const $ = (id) => document.getElementById(id);
const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const state = {
  set: null, // which birds sing: null until chosen, "settlement" | "all"
  grid: "h3",
  start: null, // { lat, lng, label }
  end: null,
  mode: "hex",
  length: "medium",
  // A recorded route (from a live session or a shared link) that stands in
  // for start and end: [{ point: [lat, lng], res, birds }].
  path: null,
  pathShared: false, // whether the path may be written into the address bar
  pathTitle: "Recorded trip",
  perStop: 3, // 3: birds in turn; 1: all together
  pace: "steady",
  route: null,
  routePending: false, // a road route has been asked for and isn't back yet
  birdsFailed: false, // the range lists for the route couldn't be fetched
  cueStop: 0,
  playing: null, // null | "route" | "spot" | "live"
  finished: false,
};

const aviary = new Aviary();
const player = new Player(aviary);
let map;
let theme = document.documentElement.dataset.theme;
let routeRequest = 0;
let routeAbort = null;
let song = null;
let spot = null; // { popup, birds } for the last clicked point
let live = null; // { session, recorder, started, fix } while a live session runs
let lastRecording = null; // { blob, birds } from the last live session
const objectUrls = [];
const pinElements = { start: null, end: null };
const places = {
  start: { input: $("start-input"), status: $("start-status"), candidates: $("start-candidates"), form: $("start-form"), lastQuery: "", searching: null, abort: null },
  end: { input: $("end-input"), status: $("end-status"), candidates: $("end-candidates"), form: $("end-form"), lastQuery: "", searching: null, abort: null },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function formatKm(km) {
  if (km >= 100) return `${Math.round(km).toLocaleString()} km`;
  if (km >= 1) return `${km.toFixed(1)} km`;
  if (km >= 0.001 || km === 0) return `${Math.round(km * 1000)} m`;
  return `${Math.round(km * 100000)} cm`;
}

function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatSize(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 7000);
}

function remember(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* private mode */ }
}

function recall(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (error) { return null; }
}

// Files offered for download are kept only while their dialog is open.
function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function releaseUrls() {
  for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
}

function grid() {
  return GRIDS[state.grid];
}

function pace() {
  return PACES[state.pace].seconds;
}

function songTitle() {
  if (state.path) return state.pathTitle;
  return `${state.start.label} → ${state.end.label}`;
}

// ---------------------------------------------------------------------------
// Shareable state in the URL hash
// ---------------------------------------------------------------------------

// Safari refuses more than ~100 history updates in 30 seconds, so writes
// are collected.
let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(flushHash, 300);
}

function flushHash() {
  clearTimeout(hashTimer);
  // A travelled route only goes into the address once its owner has chosen
  // to share it (or it arrived in a link in the first place).
  const hash = encodeState(state, state.pathShared);
  try {
    history.replaceState(null, "", `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`);
  } catch (error) {
    // The link just goes a little stale; nothing else depends on it.
  }
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function pinElement(letter, which) {
  const el = document.createElement("div");
  el.className = `marker-pin ${letter.toLowerCase()}`;
  el.title = `${which === "start" ? "Start" : "End"} (drag to move)`;
  el.setAttribute("aria-label", `${which === "start" ? "Start" : "End"} pin. Drag to move, or edit the ${which} field.`);
  el.innerHTML = `<svg viewBox="0 0 30 38" aria-hidden="true"><path d="M15 37C8 27 2 21 2 14a13 13 0 0 1 26 0c0 7-6 13-13 23z" stroke="#0c0f0d" stroke-width="1.5"/><text x="15" y="19" text-anchor="middle">${letter}</text></svg>`;
  return el;
}

function playheadElement() {
  const el = document.createElement("div");
  el.className = "playhead";
  el.innerHTML = `<svg class="pick" viewBox="0 0 26 26" aria-hidden="true"><path d="M13 24C7 18.5 2.5 13 2.5 8.5a10.5 6.5 0 0 1 21 0C23.5 13 19 18.5 13 24z"/></svg>`;
  return el;
}
const playheadEl = playheadElement();

// Stands in for the map when the browser can't draw one: any property of it
// is itself, any call returns itself, and read as a number it is 0. So
// `map.goTo(...)` simply does nothing.
function nothing() {
  const self = new Proxy(function () {}, {
    get: (target, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : self),
    set: () => true,
    apply: () => self,
    construct: () => self,
  });
  return self;
}

function initMap() {
  try {
    // ?nomap shows the page as it is for a browser that can't draw the map.
    if (new URLSearchParams(location.search).has("nomap")) throw new Error("Map switched off by ?nomap");
    map = createMapView({
      target: "map",
      inset: "inset",
      theme,
      colours: MAP_COLOURS[theme],
      onClick: (lat, lng) => {
        hideArrival();
        // A live session owns the sound and the route; nothing to pin.
        if (!live) openSpot(lat, wrapLng(lng), true);
      },
      onUserMove: () => {
        if ($("follow").checked) $("follow").checked = false;
      },
      onLocate: (lat, lng) => {
        if (!live) openSpot(lat, lng, false);
      },
      onInset: () => map.showChathams(),
    });
  } catch (error) {
    // Trips, sound, sharing and downloads don't need the map, so carry on
    // without it.
    console.warn("No map:", error.message);
    map = nothing();
    $("map").replaceChildren();
    $("inset").hidden = true;
    document.body.classList.add("no-map");
    $("map-missing").hidden = false;
    return;
  }
  drawRoute();
}

function drawRoute() {
  const route = state.route;
  map.setRoute(route ? stopsToGeoJSON(route) : null, route ? route.track : []);
  shownStop = null;
  shownKm = null;
  renderPlayhead();
}

function setMarker(which) {
  const place = state[which];
  if (!pinElements[which]) {
    const el = pinElement(which === "start" ? "A" : "B", which);
    // A click on a pin shouldn't also open the spot popup underneath it.
    el.addEventListener("click", (event) => event.stopPropagation());
    pinElements[which] = el;
  }
  map.setPin(which, place, pinElements[which], (lat, lng) => {
    const at = { lat: Math.max(-90, Math.min(90, lat)), lng: wrapLng(lng) };
    setPlace(which, { ...at, label: formatLatLng(at.lat, at.lng) }, { move: false });
  });
}

function fitRoute(animate = true) {
  const route = state.route;
  if (!route || document.body.classList.contains("no-map")) return;
  const points = [...route.track];
  for (const cell of stopsToGeoJSON(route).features) points.push(...cell.geometry.coordinates[0]);
  const stage = $("stage").getBoundingClientRect();
  const deck = $("deck").getBoundingClientRect();
  // On wide screens the deck floats over the bottom of the map.
  const overlap = Math.max(0, stage.bottom - deck.top);
  const side = Math.min(70, stage.width * 0.12);
  map.fit(points, { top: 60, left: side, right: side, bottom: Math.min(stage.height * 0.5, overlap + 40) }, animate);
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

function setStatus(which, text, isError = false) {
  const el = places[which].status;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function setPlace(which, place, { move = true } = {}) {
  const ui = places[which];
  if (ui.abort) ui.abort.abort();
  // Choosing a place starts a planned trip; a recorded one makes way.
  if (state.path) setLiveStatus("");
  state.path = null;
  state.pathShared = false;
  state[which] = place;
  ui.input.value = place ? place.label : "";
  ui.lastQuery = ui.input.value.trim();
  ui.candidates.replaceChildren();
  setStatus(which, "");
  setMarker(which);
  hideArrival();
  closeSpot();
  if (place && move && !(state.start && state.end)) {
    map.goTo(place.lat, place.lng, { metresPerPixel: PLACE_METRES_PER_PIXEL, zoomInOnly: true });
  }
  writeHash();
  rebuildRoute({ fit: move });
}

async function findPlace(which, force = false) {
  const ui = places[which];
  const text = ui.input.value.trim();
  // Enter fires both "change" and "submit"; one lookup is enough.
  if (text === ui.searching || (!force && text === ui.lastQuery)) return;
  ui.lastQuery = text;
  if (ui.abort) ui.abort.abort();
  ui.candidates.replaceChildren();
  if (!text) {
    if (state[which]) setPlace(which, null);
    setStatus(which, "");
    return;
  }
  const abort = new AbortController();
  ui.abort = abort;
  ui.searching = text;
  const button = ui.form.querySelector("button");
  button.disabled = true;
  setStatus(which, "Searching…");
  let results;
  try {
    results = await geocode(text, abort.signal);
  } catch (error) {
    if (abort.signal.aborted) return;
    ui.lastQuery = "";
    setStatus(which, error.message, true);
    return;
  } finally {
    if (ui.abort === abort) {
      button.disabled = false;
      ui.searching = null;
    }
  }
  if (abort.signal.aborted) return;
  if (!results.length) {
    setStatus(which, `No match for “${text}”. Try adding a state, province or country, or click the map.`, true);
    return;
  }
  setPlace(which, results[0]);
  showCandidates(which, results, results[0]);
}

// The other matches for a search, tucked away until asked for. Picking one
// keeps the list, so the first answer can be picked again.
function showCandidates(which, results, chosen, open = false) {
  const box = places[which].candidates;
  box.replaceChildren();
  const others = results.filter((result) => result !== chosen);
  if (!others.length) return;
  const details = document.createElement("details");
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = `Not the right one? ${others.length} other ${others.length === 1 ? "match" : "matches"}`;
  details.append(summary);
  for (const other of others) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate";
    button.textContent = other.detail;
    button.title = other.detail;
    button.addEventListener("click", () => {
      setPlace(which, other);
      showCandidates(which, results, other, true);
    });
    details.append(button);
  }
  box.append(details);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

// The birds of each stop: those of one spot inside its hexagon, picked by
// the hexagon's ID (see spotIn in birds.js). A trip that starts and ends in
// the same hexagon gives its end stop the birds of the end point itself.
// The range tiles the stops need are fetched first.
async function giveBirds(stops) {
  const spots = stops.map((stop, i) => (i > 0 && stop.cell === stops[i - 1].cell
    ? h3.latLngToCell(stop.point[0], stop.point[1], 15)
    : spotIn(stop.cell)));
  await prepareCells(spots);
  stops.forEach((stop, i) => {
    const found = birdsAt(spots[i]);
    stop.birds = found ? found.birds : [];
    stop.local = found ? found.local : 0;
  });
}

async function pathRoute() {
  const route = buildPathRoute(grid(), state.path);
  // A recorded stop plays its cell's birds, taken at the centre, so they
  // don't depend on the exact point stored or shared.
  const fresh = route.stops.filter((stop, i) => !state.path[i].birds);
  await giveBirds(fresh);
  route.stops.forEach((stop, i) => {
    const entry = state.path[i];
    if (!entry.birds) {
      entry.birds = stop.birds;
      entry.local = stop.local;
    }
    stop.birds = entry.birds;
    stop.local = entry.local;
  });
  return route;
}

async function rebuildRoute({ fit = true } = {}) {
  const request = ++routeRequest;
  if (routeAbort) routeAbort.abort();
  stopPlayback();
  state.cueStop = 0;
  state.finished = false;
  // Nothing is playable until the new route exists; an old route left in
  // place could be played and then swapped out from under the song.
  state.route = null;
  state.routePending = false;
  state.birdsFailed = false;

  if (state.path) {
    let route;
    try {
      route = await pathRoute();
    } catch (error) {
      console.warn(error);
      if (request !== routeRequest) return;
      state.birdsFailed = true;
      renderRoute();
      return;
    }
    if (request !== routeRequest) return;
    state.route = route;
  } else if (state.start && state.end) {
    const a = [state.start.lat, state.start.lng];
    const b = [state.end.lat, state.end.lng];
    const maxStops = LENGTHS[state.length].stops;
    let route;
    let note = "";
    if (state.mode === "road") {
      routeAbort = new AbortController();
      state.routePending = true;
      drawRoute();
      renderRoute();
      try {
        route = await buildRoadRoute(grid(), a, b, maxStops, routeAbort.signal);
      } catch (error) {
        if (request !== routeRequest) return;
        if (!(error instanceof RoutingError)) console.warn(error);
        const why = error instanceof RoutingError ? error.message : "road routing failed";
        note = `Couldn’t follow roads: ${why}. Walked the hexagons instead.`;
      }
      if (request !== routeRequest) return;
    }
    if (!route) route = buildWalkRoute(grid(), a, b, maxStops);
    state.routePending = true;
    renderRoute();
    try {
      await giveBirds(route.stops);
    } catch (error) {
      console.warn(error);
      if (request !== routeRequest) return;
      state.routePending = false;
      state.birdsFailed = true;
      renderRoute();
      return;
    }
    if (request !== routeRequest) return;
    state.routePending = false;
    route.note = note;
    state.route = route;
  }
  drawRoute();
  renderRoute();
  if (fit) fitRoute();
}

function renderRoute() {
  const route = state.route;
  const summary = $("route-summary");
  // During a live session there is nothing to play until a position arrives.
  $("play").disabled = live ? !live.started : !route;
  $("play").title = live && !live.started ? "Waiting for your location" : "";
  $("stop").disabled = !route && !live;
  for (const id of ["share", "download"]) {
    $(id).disabled = !route || Boolean(live);
    $(id).title = live ? "Available when the live session ends" : $(id).getAttribute("aria-label");
  }
  // A recorded route keeps the stops it was travelled with.
  $("route-choices").disabled = Boolean(state.path);
  $("route-note").hidden = !state.path;
  summary.classList.toggle("busy", state.routePending);
  renderSummaries();
  if (!route && state.birdsFailed) {
    summary.innerHTML = 'The bird lists for this trip didn’t load. <button type="button" class="link" id="retry-birds">Try again</button>';
    $("retry-birds").addEventListener("click", () => rebuildRoute());
    $("deck-title").textContent = "The birds didn’t load.";
    $("deck-sub").textContent = "";
    $("chart").replaceChildren();
    $("now").replaceChildren();
    $("progress-bar").style.width = "0";
    return;
  }
  if (!route) {
    summary.textContent = state.routePending ? (state.mode === "road" ? "Finding a road route…" : "Finding the birds…") : "";
    $("deck-title").textContent = live
      ? "Finding you…"
      : state.routePending
        ? "Finding the birds…"
        : state.start || state.end
          ? `Now add ${state.start ? "an end" : "a start"} to write a song.`
          : "Pick a start and an end to write a song.";
    $("deck-sub").textContent = "";
    $("chart").replaceChildren();
    $("now").replaceChildren();
    $("progress-bar").style.width = "0";
    return;
  }
  const count = `${route.stops.length} ${route.stops.length === 1 ? "stop" : "stops"}`;
  const notes = [];
  let facts;
  if (route.mode === "path") {
    facts = `${formatKm(route.distanceKm)} travelled`;
  } else {
    const distance = route.straightKm === 0
      ? "no distance at all"
      : route.mode === "road"
        ? `${formatKm(route.distanceKm)} by road`
        : `${formatKm(route.straightKm)} as the crow flies`;
    facts = `${distance} · a stop every ${formatKm(route.grid.spacingKm(route.res))}`;
    if (route.note) notes.push(route.note);
    if (route.mode === "road" && route.snapKm) {
      const far = Math.max(...route.snapKm);
      if (far > Math.max(1, route.distanceKm * 0.02)) {
        notes.push(`The nearest road is ${formatKm(far)} from ${route.snapKm[0] >= route.snapKm[1] ? "the start" : "the end"}; the line jumps straight to it.`);
      }
    }
    if (route.straightKm === 0) notes.push("Start and end are the same spot, so this is a very short song.");
  }
  const quiet = route.stops.filter((stop) => !stop.birds.length).length;
  if (!state.set) {
    notes.push("Choose which birds sing, in section 1, to hear this trip.");
  } else if (quiet === route.stops.length) {
    notes.push("None of these stops has three birds of this set: the area is New Zealand’s main islands, nearshore islands and the Chathams, on land and near the coast.");
  } else if (quiet) {
    notes.push(`${quiet} ${quiet === 1 ? "stop has" : "stops have"} fewer than three birds of this set, or ${quiet === 1 ? "is" : "are"} out at sea: a short quiet turn each.`);
  }
  summary.innerHTML = `<strong>${count}</strong> · ${escapeHTML(facts)}` +
    notes.map((text) => `<span class="note">${escapeHTML(text)}</span>`).join("");
  $("deck-title").textContent = live && !live.started ? "Finding you…" : songTitle();
  renderChart();
  renderSongInfo();
  renderPlayhead();
}

function renderChart() {
  const route = state.route;
  const items = route.stops.map((stop, i) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const names = stop.birds.length
      ? stop.birds.map((bird, which) => `<span class="c" data-which="${which}">${escapeHTML(shortName(bird))}</span>`).join("")
      : '<span class="c quiet">no birds</span>';
    button.innerHTML = `<span class="n">${i + 1}</span>${names}`;
    button.setAttribute("aria-label", `Stop ${i + 1}: ${stop.birds.length ? stop.birds.map(fullName).join(", ") : "no birds"}`);
    button.tabIndex = i === 0 ? 0 : -1;
    button.addEventListener("click", () => jumpToStop(i));
    li.append(button);
    return li;
  });
  $("chart").replaceChildren(...items);
  shownStop = null;
}

// The chart is one tab stop; arrow keys walk along it.
function onChartKey(event) {
  const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
  if (!step) return;
  const buttons = [...$("chart").querySelectorAll("button")];
  const from = buttons.indexOf(document.activeElement);
  if (from < 0) return;
  event.preventDefault();
  const to = Math.max(0, Math.min(buttons.length - 1, from + step));
  buttons.forEach((button, i) => { button.tabIndex = i === to ? 0 : -1; });
  buttons[to].focus();
}

function totalBars() {
  return makeSong().bars;
}

function renderSongInfo(position) {
  if (!state.route) return;
  const stops = state.route.stops.length;
  const count = `${stops} ${stops === 1 ? "stop" : "stops"}`;
  if (live) {
    const fix = live.fix;
    const gps = fix ? ` · ${paceName(fix.pace)} · GPS ±${Math.round(fix.accuracy)} m` : "";
    $("deck-sub").textContent = live.started
      ? `Live · ${count} · ${formatKm(state.route.distanceKm)}${gps}`
      : "Waiting for a location fix…";
    return;
  }
  const total = songSeconds(totalBars(), pace());
  if (position && state.playing === "route") {
    const elapsed = position.ending ? total : (position.bar + position.fraction) * pace();
    const stop = position.ending ? stops : position.info.stop + 1;
    $("deck-sub").textContent = `Stop ${stop}/${stops} · ${formatClock(elapsed)} / ${formatClock(total)}`;
  } else {
    const from = state.cueStop > 0 ? ` · starts at stop ${state.cueStop + 1}` : "";
    $("deck-sub").textContent = `${count} · about ${formatClock(total)}${from}`;
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

// The song: each stop takes three turns (birds in turn) or one (all
// together); a stop with no birds takes one quiet turn either way.
// barAt() says which stop and bird a turn is, and which of its stop's turns.
function makeSong(per = state.perStop) {
  const stops = state.route.stops;
  const first = [];
  const owner = [];
  stops.forEach((stop, i) => {
    first.push(owner.length);
    const turns = stop.birds.length ? per : 1;
    for (let t = 0; t < turns; t++) owner.push(i);
  });
  return {
    per,
    bars: owner.length,
    // The first turn of a stop (or the song's length, past the last stop).
    firstBar: (stop) => (stop < stops.length ? first[stop] : owner.length),
    stopAt: (bar) => owner[Math.min(bar, owner.length - 1)],
    barAt(bar) {
      const stop = owner[bar];
      const turn = bar - first[stop];
      const birds = stops[stop].birds;
      if (!birds.length) return { birds: [], stop, which: -1, turn: 0, turns: 1 };
      if (per === 1) return { birds, stop, which: -1, turn: 0, turns: 1 };
      return { birds: [birds[turn]], stop, which: turn, turn, turns: 3 };
    },
  };
}

function setPlayButton() {
  const playing = (state.playing === "route" || state.playing === "live") && player.state === "playing";
  $("play").classList.toggle("playing", playing);
  $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("stop").setAttribute("aria-label", live ? "End the live session" : "Stop and go back to the start");
}

async function startAudio(run) {
  const button = $("play");
  button.classList.add("busy");
  try {
    await run();
    return true;
  } catch (error) {
    console.warn(error);
    toast(error.message || "Audio couldn’t start in this browser.");
    stopPlayback();
    return false;
  } finally {
    button.classList.remove("busy");
  }
}

// Nothing plays until a set of birds is chosen: point to the choice.
function needSet() {
  if (state.set) return false;
  toast(NEED_SET);
  $("birdset").classList.remove("attention");
  void $("birdset").offsetWidth;
  $("birdset").classList.add("attention");
  document.querySelector('input[name="set"]').focus({ preventScroll: true });
  $("birdset").scrollIntoView({ block: "nearest", behavior: "smooth" });
  return true;
}

async function setBirds(id) {
  state.set = id;
  setBirdSet(id);
  $("set-explain").textContent = SET_EXPLAIN[id || "none"];
  $("birdset").classList.toggle("unchosen", !id);
  $("birdset").classList.remove("attention");
  writeHash();
  closeSpot();
  // Same trip, new birds: every address depends on the set.
  stopPlayback();
  const route = state.route;
  if (route) {
    try {
      await giveBirds(route.stops);
    } catch (error) {
      console.warn(error);
      state.birdsFailed = true;
    }
    if (route !== state.route) return;
    state.cueStop = 0;
    state.finished = false;
    renderRoute();
  }
}

async function togglePlay() {
  hideArrival();
  if (!live && needSet()) return;
  if (live) {
    // During a live session the button only mutes and unmutes the birds.
    if (state.playing !== "live") return;
    if (player.state === "playing") player.pause();
    else await startAudio(() => player.resume());
    setPlayButton();
    return;
  }
  if (!state.route) return;
  if (state.playing === "route" && player.state === "playing") {
    player.pause();
  } else if (state.playing === "route" && player.state === "paused") {
    await startAudio(() => player.resume());
  } else {
    if (state.finished) {
      state.finished = false;
      state.cueStop = 0;
    }
    song = makeSong();
    state.playing = "route";
    const request = routeRequest;
    await startAudio(() => player.play(song, song.firstBar(state.cueStop)));
    // The route changed while the recordings were still loading.
    if (request !== routeRequest) stopPlayback();
  }
  setPlayButton();
}

function stopPlayback() {
  player.stop();
  state.playing = null;
  setPlayButton();
  highlightSpot(-1);
}

function stopAndRewind() {
  if (live) {
    endLive();
    return;
  }
  stopPlayback();
  state.cueStop = 0;
  state.finished = false;
  renderSongInfo();
  renderPlayhead();
}

function jumpToStop(index) {
  if (!state.route || live) return;
  state.finished = false;
  if (state.playing === "route" && player.state === "playing") {
    player.seek(song.firstBar(index));
    return;
  }
  stopPlayback();
  state.cueStop = index;
  renderSongInfo();
  renderPlayhead();
}

player.onEnd = () => {
  const wasRoute = state.playing === "route";
  stopPlayback();
  if (wasRoute) {
    state.finished = true;
    state.cueStop = 0;
    renderSongInfo();
    renderPlayhead();
  }
};

// ---------------------------------------------------------------------------
// Playhead rendering
// ---------------------------------------------------------------------------

let shownStop = null; // "stop:which" currently painted in the chart and cards
let shownKm = null; // how far the travelled line has been drawn
let shownBar = null;

function placePlayhead(lat, lng, visible) {
  map.setPlayhead(lat, lng, playheadEl);
  playheadEl.style.visibility = visible ? "" : "hidden";
  playheadEl.classList.toggle("live", Boolean(live));
}

function drawTravelled(route, km) {
  // Redrawing the travelled line is the one costly step, so only do it
  // once the playhead has visibly moved on.
  const moved = shownKm === null || Math.abs(km - shownKm) >= route.distanceKm / 1500;
  if ((moved || km === 0 || km === route.distanceKm) && km !== shownKm) {
    map.setTravelled(trackUpTo(route, km));
    shownKm = km;
  }
}

// Marks which stop and bird are up: cells on the map, the bird cards and
// the chart. `which` is the bird singing, or -1 for all three together.
function showStop(route, stop, which, played, sounding) {
  const key = `${stop}:${which}:${played}:${sounding}:${route.stops.length}:${state.perStop}`;
  if (key === shownStop) return;
  shownStop = key;
  const stops = route.stops;
  const current = played > stops.length - 1 ? -1 : stop;
  map.setProgress(played, current);
  renderNow(stops[stop], which, sounding);
  const items = $("chart").children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle("played", i < played);
    items[i].classList.toggle("current", i === current);
    if (i === current) items[i].firstChild.setAttribute("aria-current", "step");
    else items[i].firstChild.removeAttribute("aria-current");
    for (const span of items[i].querySelectorAll(".c")) {
      span.classList.toggle("on", i === current && sounding && (which === -1 || Number(span.dataset.which) === which));
    }
  }
  const item = items[stop];
  if (item && sounding) {
    const chart = $("chart");
    const target = item.offsetLeft - chart.offsetLeft - chart.clientWidth / 2 + item.offsetWidth / 2;
    chart.scrollTo({ left: target, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}

// Paints everything that depends on where the song is: marker, cells,
// progress line, bird cards and chart. With no position, shows the cue.
function renderPlayhead(position) {
  const route = state.route;
  if (!route) {
    map.hidePlayhead();
    return;
  }
  if (live) {
    // Until the first fix, the old trip is still on screen; leave it be.
    if (live.started) renderLive(position);
    return;
  }
  const stops = route.stops;
  const last = stops.length - 1;
  let stop;
  let which;
  let km;
  let played; // stops fully behind us
  if (position && !position.ending) {
    stop = position.info.stop;
    which = position.info.which;
    if (!stops[stop]) return;
    const into = (position.info.turn + position.fraction) / position.info.turns;
    const next = stops[Math.min(last, stop + 1)].trackKm;
    km = stops[stop].trackKm + (next - stops[stop].trackKm) * into;
    played = stop;
  } else if (position || state.finished) {
    stop = last;
    which = state.perStop === 3 ? 0 : -1;
    km = route.distanceKm;
    played = stops.length;
  } else {
    stop = Math.min(last, state.cueStop);
    which = state.perStop === 3 ? 0 : -1;
    km = stops[stop].trackKm;
    played = stop;
  }

  const at = pointAt(route, km);
  // Parked on the start or end it would only hide the pin.
  placePlayhead(at[0], at[1], Boolean(position) || (km > 0 && km < route.distanceKm));
  if (position && $("follow").checked) map.jumpTo(at[0], at[1]);
  drawTravelled(route, km);
  const total = position && !position.ending ? (position.bar + position.fraction) / song.bars : played / stops.length;
  $("progress-bar").style.width = `${Math.min(100, total * 100).toFixed(2)}%`;
  showStop(route, stop, which, played, Boolean(position) && !position.ending);
}

// A live session has no end to move towards: the marker is wherever the
// device is, and the newest stop is the one being played.
function renderLive(position) {
  const route = state.route;
  const stop = route.stops.length - 1;
  const fix = live.fix;
  if (fix) placePlayhead(fix.point[0], fix.point[1], true);
  drawTravelled(route, route.distanceKm);
  $("progress-bar").style.width = "0";
  const sounding = Boolean(position) && player.state === "playing";
  showStop(route, stop, position ? position.info.which : 0, stop, sounding);
}

// ---------------------------------------------------------------------------
// Birds on screen
// ---------------------------------------------------------------------------

// Birds are named in te reo Māori first, where iNaturalist has a Māori
// name, and in English after.
const shortName = (bird) => bird.mi || bird.name;
const fullName = (bird) => (bird.mi ? `${bird.mi} (${bird.name})` : bird.name);

function birdCard(bird, className = "") {
  const photo = bird.photo
    ? `<img src="${escapeHTML(bird.photo)}" alt="" loading="lazy" decoding="async">`
    : '<span class="no-photo" aria-hidden="true"></span>';
  return `<button type="button" class="bird-card ${className}" data-bird="${bird.index}" aria-label="${escapeHTML(fullName(bird))}: who recorded it, and on what terms">${photo}<span class="name">${escapeHTML(shortName(bird))}</span>${bird.mi ? `<span class="name-en">${escapeHTML(bird.name)}</span>` : ""}</button>`;
}

// The three birds of the stop under the playhead.
function renderNow(stop, which, sounding) {
  if (!stop.birds.length) {
    $("now").innerHTML = `<p class="now-quiet">${escapeHTML(QUIET)}</p>`;
    return;
  }
  $("now").innerHTML = stop.birds.map((bird, i) => {
    const on = sounding && (which === -1 || i === which);
    return birdCard(bird, on ? "on" : "");
  }).join("");
}

// An empty src asks some browsers to fetch the page itself; leave it out.
function setImage(img, url) {
  if (url) img.src = url;
  else img.removeAttribute("src");
  img.hidden = !url;
}

// Who recorded a bird and took its picture, and on what terms. Opens when
// a bird card is selected; the sonogram is only fetched then.
function openBird(index) {
  const bird = catalogueInfo().birds[index];
  if (!bird) return;
  const rec = bird.rec;
  $("bird-title").textContent = shortName(bird);
  $("bird-sci").textContent = bird.mi ? `${bird.name} · ${bird.sci}` : bird.sci;
  setImage($("bird-photo"), bird.photo);
  const rows = [
    ["Recording", `<a href="https://xeno-canto.org/${encodeURIComponent(rec.xc)}" target="_blank" rel="noopener">XC${escapeHTML(rec.xc)}</a> by ${escapeHTML(rec.by || "unknown")}${rec.type ? ` (${escapeHTML(rec.type)})` : ""}. ${rec.where ? `Made in ${escapeHTML(rec.where)}, not at this place` : "Not made at this place"}: this one recording stands in for the species everywhere.`],
    ["Licence", `<a href="${escapeHTML(rec.licUrl || licenceUrl(rec.lic))}" target="_blank" rel="noopener">${escapeHTML(licenceName(rec.lic))}</a>. Cut to a few seconds and re-encoded here.`],
  ];
  if (bird.photo) {
    rows.push(["Photo", `${escapeHTML(bird.photoBy || "")}${bird.inat ? ` · <a href="${escapeHTML(bird.inat)}" target="_blank" rel="noopener">iNaturalist</a>` : ""}`]);
  }
  $("bird-credits").innerHTML = rows.map(([term, text]) => `<dt>${term}</dt><dd>${text}</dd>`).join("");
  $("bird-sono-figure").hidden = !rec.sono;
  setImage($("bird-sono"), rec.sono);
  $("bird-dialog").showModal();
}

// ---------------------------------------------------------------------------
// Clicking the map: hear one spot
// ---------------------------------------------------------------------------

// Closes the spot popup, or forgets one still waiting for its birds.
function closeSpot() {
  if (!spot) return;
  if (spot.popup) spot.popup.remove();
  spot = null;
}

function highlightSpot(which) {
  if (!spot) return;
  const element = spot.popup && spot.popup.getElement();
  const cards = element ? element.querySelectorAll(".bird-card") : [];
  cards.forEach((card, i) => card.classList.toggle("on", which === -1 ? false : which === 3 || i === which));
}

async function playSpot() {
  if (!spot || live || !spot.birds.length) return;
  // Hearing a spot interrupts the song; remember the stop so Play picks
  // it up again from there.
  const position = state.playing === "route" ? player.position() : null;
  stopPlayback();
  if (position && !position.ending) state.cueStop = position.info.stop;
  renderSongInfo();
  renderPlayhead();
  const birds = spot.birds;
  const together = state.perStop === 1;
  state.playing = "spot";
  await startAudio(() => player.play({
    bars: together ? 1 : 3,
    barAt: (bar) => (together ? { birds, which: 3 } : { birds: [birds[bar]], which: bar }),
  }));
}

async function openSpot(lat, lng, autoplay) {
  closeSpot();
  const content = document.createElement("div");
  content.className = "spot";
  const opened = { popup: null, birds: [] };
  spot = opened;
  let found = null;
  let failed = false;
  try {
    await prepareBirds([[lat, lng]]);
    found = birdsFor(lat, lng);
  } catch (error) {
    console.warn(error);
    failed = true;
  }
  if (spot !== opened) return;
  opened.birds = found ? found.birds : [];
  const why = !state.set ? NEED_SET : failed ? "The bird list for this area didn’t load. Click the map again to retry." : QUIET;
  content.innerHTML = `
    <p class="spot-title">${escapeHTML(formatLatLng(lat, lng))}${found ? ` · three of the ${found.local} birds on this area’s range-map list` : ""}</p>
    ${found
      ? `<div class="spot-birds">${found.birds.map((bird) => birdCard(bird)).join("")}</div>`
      : `<p class="spot-quiet">${escapeHTML(why)}</p>`}
    <div class="spot-actions">
      ${found ? '<button type="button" class="button" data-action="hear">▶ Hear it</button>' : ""}
      <button type="button" class="button quiet" data-action="start">Start here</button>
      <button type="button" class="button quiet" data-action="end">End here</button>
    </div>`;
  content.addEventListener("click", (event) => {
    const card = event.target.closest(".bird-card");
    if (card) {
      openBird(Number(card.dataset.bird));
      return;
    }
    const action = event.target.closest("button") && event.target.closest("button").dataset.action;
    if (action === "hear") playSpot();
    else if (action) setPlace(action, { lat, lng, label: formatLatLng(lat, lng) }, { move: false });
  });
  opened.popup = map.openPopup(lat, lng, content, () => {
    if (spot !== opened) return;
    if (state.playing === "spot") stopPlayback();
    spot = null;
  });
  // Don't talk over a song that's already going.
  if (autoplay && !state.playing && found) playSpot();
}

// ---------------------------------------------------------------------------
// Live session: the song follows the device
// ---------------------------------------------------------------------------

function setLiveStatus(text, isError = false) {
  $("live-status").textContent = text;
  $("live-status").classList.toggle("error", isError);
}

function renderLiveControls() {
  const on = Boolean(live);
  $("live-label").textContent = on ? "End session" : "Go live";
  $("live-toggle").classList.toggle("on", on);
  $("live-pitch").hidden = on;
  $("live-note").hidden = !on;
  $("trip-fields").disabled = on;
  // The set can't change under a live session: it would mix the recording.
  for (const input of document.querySelectorAll('input[name="set"]')) input.disabled = on;
  $("trip").classList.toggle("is-live", on);
  setPlayButton();
}

function startLive() {
  if (needSet()) return;
  const problem = liveSupport();
  if (problem) {
    setLiveStatus(problem, true);
    return;
  }
  stopPlayback();
  hideArrival();
  closeSpot();
  // Unlock audio while this click still counts; the first bird has to wait
  // for a position.
  Tone.start();
  live = {
    session: new LiveSession(grid(), { onStop: onLiveStop, onFix: onLiveFix, onError: onLiveError }),
    recorder: null,
    started: false,
    fix: null,
  };
  setLiveStatus("Finding you…");
  $("live-download").hidden = true;
  lastRecording = null;
  renderLiveControls();
  renderRoute();
  live.session.start();
}

function onLiveError(message, fatal) {
  if (!live) return;
  if (fatal) {
    endLive();
    setLiveStatus(message, true);
  } else {
    setLiveStatus(message);
  }
}

function onLiveFix(fix) {
  if (!live) return;
  const first = !live.fix;
  live.fix = fix;
  if (first || $("follow").checked) {
    // Close enough to see a few cells around you.
    const metresPerPixel = (grid().spacingKm(fix.res) * 1000) / 110;
    map.goTo(fix.point[0], fix.point[1], { metresPerPixel: first ? metresPerPixel : undefined, duration: 600 });
  }
  if (first) $("follow").checked = true;
  renderSongInfo();
  if (player.state !== "playing") renderPlayhead();
}

async function onLiveStop(stop) {
  if (!live) return;
  const session = live;
  const entry = { point: stop.point, res: stop.res };
  if (session.started) {
    state.path.push(entry);
  } else {
    // The trip that was on screen gives way to the one being travelled.
    session.started = true;
    routeRequest++;
    if (routeAbort) routeAbort.abort();
    for (const which of ["start", "end"]) {
      state[which] = null;
      places[which].input.value = "";
      places[which].lastQuery = "";
      places[which].candidates.replaceChildren();
      setStatus(which, "");
      setMarker(which);
    }
    state.path = [entry];
    state.pathShared = false;
    state.pathTitle = "Live session";
    state.routePending = false;
    state.cueStop = 0;
    state.finished = false;
    setLiveStatus("");
    writeHash();
  }
  // Stops can arrive faster than their birds load; only the newest counts.
  const ticket = (session.ticket = (session.ticket || 0) + 1);
  let route;
  try {
    route = await pathRoute();
  } catch (error) {
    console.warn(error);
    setLiveStatus("The birds for this spot didn’t load; trying again at the next one.");
    return;
  }
  if (live !== session || ticket !== session.ticket) return;
  state.route = route;
  drawRoute();
  renderRoute();
  if (!session.sounding) {
    session.sounding = true;
    beginLiveSound();
  }
}

async function beginLiveSound() {
  const session = live;
  state.playing = "live";
  const started = await startAudio(() => player.play({
    bars: Infinity,
    // Always the newest stop; its birds go round until there's a newer one.
    barAt: (bar) => {
      const stops = state.route.stops;
      const birds = stops[stops.length - 1].birds;
      if (state.perStop === 1) return { birds, stop: stops.length - 1, which: -1 };
      const which = bar % 3;
      return { birds: birds[which] ? [birds[which]] : [], stop: stops.length - 1, which };
    },
  }));
  if (live !== session) {
    // Ended while the recordings were loading.
    if (started && !live) stopPlayback();
    return;
  }
  if (!started) {
    state.playing = "live";
    setLiveStatus("The sound didn’t start. Tap play to try again.", true);
  } else if (LiveRecorder.supported) {
    try {
      session.recorder = new LiveRecorder(aviary);
      session.recorder.start();
    } catch (error) {
      session.recorder = null;
    }
  }
  setPlayButton();
}

async function endLive() {
  const session = live;
  if (!session) return;
  live = null;
  session.session.stop();
  stopPlayback();
  renderLiveControls();
  $("follow").checked = false;
  if (!session.started) {
    setLiveStatus("");
    renderRoute();
    return;
  }
  const stops = state.path.length;
  setLiveStatus(`Recorded ${stops} ${stops === 1 ? "stop" : "stops"}. Replay it, change the sound, or share it. It isn’t kept if you close this page.`);
  renderRoute();
  fitRoute();
  if (session.recorder) {
    try {
      const blob = await session.recorder.stop();
      if (blob.size > 0) {
        lastRecording = { blob, birds: uniqueBirds(state.route.stops.flatMap((stop) => stop.birds)) };
        $("live-download").textContent = `Download what you heard (${formatSize(blob.size)})`;
        $("live-download").hidden = false;
      }
    } catch (error) {
      console.warn(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Sharing and downloading
// ---------------------------------------------------------------------------

async function share() {
  if (!state.route || live) return;
  if (state.path && !state.pathShared) {
    // A travelled route says where someone has been; ask first.
    $("share-title").textContent = "Share this route?";
    $("share-text").textContent = "The link will draw the route you travelled, hexagon by hexagon, including where you started and stopped. Anyone who has the link can see it.";
    $("share-link").hidden = true;
    $("share-confirm").hidden = false;
    $("share-cancel").textContent = "Cancel";
    $("share-dialog").showModal();
    return;
  }
  flushHash();
  const url = location.href;
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title: "what3birdsongs", text: songTitle(), url });
    } catch (error) {
      // Dismissing the share sheet isn't a failure.
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. It opens this trip with this sound.");
  } catch (error) {
    // No clipboard access (an insecure page, or permission refused): show
    // the link to copy by hand.
    $("share-title").textContent = "Copy this link";
    $("share-text").textContent = "It opens this trip with this sound.";
    $("share-link").value = url;
    $("share-link").hidden = false;
    $("share-confirm").hidden = true;
    $("share-cancel").textContent = "Done";
    $("share-dialog").showModal();
    $("share-link").select();
  }
}

// "Boston → New York" -> "boston-to-new-york"
function fileStem(title) {
  return title.toLowerCase().replace(/→/g, "to").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "song";
}

function uniqueBirds(birds) {
  return [...new Map(birds.map((bird) => [bird.index, bird])).values()];
}

// The birds a song actually plays, in order of first appearance.
function songBirds(song) {
  const birds = [];
  for (let bar = 0; bar < song.bars; bar++) birds.push(...song.barAt(bar).birds);
  return uniqueBirds(birds);
}

// A plain-text list of everyone whose work is in the file.
function creditsText(title, birds, licence) {
  const lines = [
    title,
    "",
    "Made with what3birdsongs (https://jethatch.github.io/what3birdsongs/).",
    `This recording mixes the bird recordings below, each cut to a few seconds and re-encoded. Taken together, their licences allow it to be shared under ${licence.name} (${licence.url}), with every recordist credited as below.`,
    "",
    "Recordings, from xeno-canto (https://xeno-canto.org/):",
  ];
  for (const bird of birds) {
    const rec = bird.rec;
    lines.push(`- ${fullName(bird)}, ${bird.sci}: XC${rec.xc} by ${rec.by || "unknown"}, https://xeno-canto.org/${rec.xc}, ${licenceName(rec.lic)} (${rec.licUrl || licenceUrl(rec.lic)})`);
  }
  lines.push("", "Which birds a place gets comes from iNaturalist's open range maps (CC BY 4.0).");
  return lines.join("\n") + "\n";
}

// Offers a finished file and its credits, or says why it can't be offered.
function offerFile(title, blob, extension, birds) {
  const check = combine(birds.map((bird) => bird.rec.lic));
  const links = $("download-links");
  links.replaceChildren();
  if (!check.ok) {
    $("download-title").textContent = "Not available for download";
    $("download-text").textContent = `This song can’t be downloaded: ${check.why}. You can still play it here and share its link.`;
    $("download-dialog").showModal();
    return;
  }
  const stem = fileStem(title);
  const credits = new Blob([creditsText(title, birds, { name: check.licence, url: check.url })], { type: "text/plain" });
  for (const [label, file, name] of [
    [`Song (${formatSize(blob.size)})`, blob, `${stem}.${extension}`],
    ["Credits", credits, `${stem}-credits.txt`],
  ]) {
    const link = document.createElement("a");
    link.className = "button";
    link.href = objectUrl(file);
    link.download = name;
    link.textContent = label;
    links.append(link);
  }
  $("download-title").textContent = "Your song";
  $("download-text").innerHTML = `It mixes ${birds.length} ${birds.length === 1 ? "recording" : "recordings"}, so it can only be shared under <a href="${escapeHTML(check.url)}" target="_blank" rel="noopener">${escapeHTML(check.licence)}</a>: ${escapeHTML(check.plain)} Keep the credits file with it; it names every recordist.`;
  $("download-dialog").showModal();
}

async function downloadSong() {
  if (!state.route || live) return;
  const button = $("download");
  if (button.classList.contains("busy")) return;
  const made = makeSong();
  const birds = songBirds(made);
  if (!birds.length) {
    toast("There are no birds on this trip to download.");
    return;
  }
  const check = combine(birds.map((bird) => bird.rec.lic));
  if (!check.ok) {
    offerFile(songTitle(), null, "wav", birds);
    return;
  }
  button.classList.add("busy");
  const title = songTitle();
  const progress = (fraction) => toast(`Rendering the song… ${Math.round(fraction * 100)}%`);
  progress(0);
  try {
    const blob = await renderSong(made, pace(), progress);
    $("toast").hidden = true;
    offerFile(title, blob, "wav", birds);
  } catch (error) {
    console.warn(error);
    toast(error.message || "The song couldn’t be rendered in this browser.");
  } finally {
    button.classList.remove("busy");
  }
}

function downloadRecording() {
  if (!lastRecording) return;
  const { blob, birds } = lastRecording;
  const extension = /mp4/.test(blob.type) ? "m4a" : /ogg/.test(blob.type) ? "ogg" : "webm";
  offerFile(`what3birdsongs live session ${new Date().toISOString().slice(0, 10)}`, blob, extension, birds);
}

// The prompt shown when the page was opened from a link to a song: browsers
// won't start sound without a click, so make the click obvious.
function showArrival() {
  if (!state.route) return;
  $("arrival-what").textContent = `${songTitle()} · ${state.perStop === 3 ? "birds in turn" : "all together"} · ${PACES[state.pace].name.toLowerCase()}`;
  $("arrival").hidden = false;
}

function hideArrival() {
  $("arrival").hidden = true;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

// The one-line "what's selected" text on the collapsed route options.
function renderSummaries() {
  const walk = state.mode === "hex" ? "Hex walk" : "Roads";
  $("route-now").textContent = state.path ? "Recorded route" : `${walk} · ${LENGTHS[state.length].name}`;
}

function setPerStop(per) {
  const old = state.perStop;
  if (per === old) return;
  state.perStop = per;
  $("perstop-explain").textContent = PER_STOP_EXPLAIN[per];
  writeHash();
  if (!state.route) return;
  if (state.playing === "route") {
    // Finish the turn in progress, then carry on from the next stop
    // counted the new way.
    const playing = song;
    const next = makeSong(per);
    player.onNextBarLine((bar) => {
      const stop = playing.stopAt(bar);
      const at = bar >= playing.bars ? next.bars : bar === playing.firstBar(stop) ? next.firstBar(stop) : next.firstBar(stop + 1);
      player.song = next;
      song = next;
      return at;
    });
  }
  renderChart();
  if (state.playing !== "route") {
    renderSongInfo();
    renderPlayhead();
  }
}

function setPace(id) {
  state.pace = id;
  $("pace-explain").textContent = PACES[id].explain;
  player.setPace(pace());
  writeHash();
  if (state.playing !== "route") renderSongInfo();
}

function setTheme(next) {
  theme = next;
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("w3b-theme", next); } catch (error) { /* private mode */ }
  document.querySelector('meta[name="theme-color"]').content = next === "dark" ? "#0c0f0d" : "#eef2ea";
  map.setTheme(next, MAP_COLOURS[next]);
}

function bindControls() {
  for (const which of ["start", "end"]) {
    const ui = places[which];
    ui.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const place = state[which];
      if (place && ui.input.value.trim() === place.label) {
        // Already found: "Find" just shows where it is.
        map.goTo(place.lat, place.lng, { metresPerPixel: PLACE_METRES_PER_PIXEL, zoomInOnly: true });
      } else {
        findPlace(which, true);
      }
    });
    // Tabbing on to the next field without pressing Enter still counts.
    ui.input.addEventListener("change", () => findPlace(which));
  }
  $("swap").addEventListener("click", () => {
    if (!state.start && !state.end) return;
    const { start, end } = state;
    state.start = end;
    state.end = start;
    for (const which of ["start", "end"]) {
      const ui = places[which];
      // A lookup still in flight would land in the wrong field.
      if (ui.abort) ui.abort.abort();
      ui.input.value = state[which] ? state[which].label : "";
      ui.lastQuery = ui.input.value;
      ui.candidates.replaceChildren();
      setStatus(which, "");
      setMarker(which);
    }
    writeHash();
    rebuildRoute();
  });

  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.addEventListener("change", () => {
      state.mode = radioValue("mode");
      $("mode-explain").textContent = MODES[state.mode].explain;
      writeHash();
      rebuildRoute();
    });
  }
  for (const input of document.querySelectorAll('input[name="length"]')) {
    input.addEventListener("change", () => {
      state.length = radioValue("length");
      $("length-explain").textContent = LENGTHS[state.length].explain;
      writeHash();
      rebuildRoute();
    });
  }
  for (const input of document.querySelectorAll('input[name="perstop"]')) {
    input.addEventListener("change", () => setPerStop(Number(radioValue("perstop"))));
  }
  for (const input of document.querySelectorAll('input[name="pace"]')) {
    input.addEventListener("change", () => setPace(radioValue("pace")));
  }
  for (const input of document.querySelectorAll('input[name="set"]')) {
    input.addEventListener("change", () => setBirds(radioValue("set")));
  }

  for (const id of SECTIONS) {
    $(id).addEventListener("toggle", () => remember("w3b-open", SECTIONS.filter((section) => $(section).open)));
  }

  $("example").addEventListener("click", () => {
    setPlace("start", { ...EXAMPLE.start });
    setPlace("end", { ...EXAMPLE.end });
  });
  $("live-toggle").addEventListener("click", () => (live ? endLive() : startLive()));
  $("live-download").addEventListener("click", downloadRecording);
  $("chart").addEventListener("keydown", onChartKey);
  $("now").addEventListener("click", (event) => {
    const card = event.target.closest(".bird-card");
    if (card) openBird(Number(card.dataset.bird));
  });
  // Our own updates use replaceState, which doesn't fire this; a hash that
  // changes any other way is a different link being opened.
  window.addEventListener("hashchange", () => location.reload());

  $("play").addEventListener("click", togglePlay);
  $("arrival-play").addEventListener("click", togglePlay);
  $("arrival-close").addEventListener("click", hideArrival);
  $("stop").addEventListener("click", stopAndRewind);
  $("share").addEventListener("click", share);
  $("download").addEventListener("click", downloadSong);
  $("share-cancel").addEventListener("click", () => $("share-dialog").close());
  $("notice-ok").addEventListener("click", () => $("notice").close());
  $("download-dialog").addEventListener("close", releaseUrls);
  $("share-confirm").addEventListener("click", () => {
    $("share-dialog").close();
    state.pathShared = true;
    share();
  });
  $("follow").addEventListener("change", () => {
    if (!$("follow").checked || !state.route) return;
    // Close enough that neighbouring stops are about 110 px apart.
    const at = map.playheadAt() || map.center();
    const metresPerPixel = (state.route.grid.spacingKm(state.route.res) * 1000) / 110;
    map.goTo(at.lat, at.lng, { metresPerPixel, duration: 600 });
  });
  $("theme-toggle").addEventListener("click", () => setTheme(theme === "dark" ? "light" : "dark"));
  $("about-open").addEventListener("click", () => $("about").showModal());
  $("what-open").addEventListener("click", () => $("what").showModal());
  $("caveat-open").addEventListener("click", () => $("about").showModal());
  for (const id of ["about", "what", "share-dialog", "bird-dialog", "download-dialog"]) {
    // A click on the backdrop closes the dialog. The backdrop reports the
    // dialog as its target, and so does the dialog's own padding, so go by
    // where the click landed.
    $(id).addEventListener("click", (event) => {
      if (event.target !== $(id)) return;
      const box = $(id).getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right &&
        event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) $(id).close();
    });
  }

  // Phones suspend audio when the screen locks or a call comes in. Try to
  // pick it up again on return; if the browser wants a tap first, say so.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || player.state !== "playing") return;
    if (Tone.getContext().state === "running") return;
    try {
      await Tone.start();
    } catch (error) {
      // Falls through to the check below.
    }
    if (Tone.getContext().state !== "running") {
      player.pause();
      setPlayButton();
      toast("The sound was paused while you were away. Press play to carry on.");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest("input, select, textarea, button, summary, a, dialog, [contenteditable]")) return;
    event.preventDefault();
    togglePlay();
  });
}

function syncControls() {
  document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked = true;
  document.querySelector(`input[name="length"][value="${state.length}"]`).checked = true;
  document.querySelector(`input[name="perstop"][value="${state.perStop}"]`).checked = true;
  document.querySelector(`input[name="pace"][value="${state.pace}"]`).checked = true;
  if (state.set) document.querySelector(`input[name="set"][value="${state.set}"]`).checked = true;
  $("set-explain").textContent = SET_EXPLAIN[state.set || "none"];
  $("birdset").classList.toggle("unchosen", !state.set);
  $("mode-explain").textContent = MODES[state.mode].explain;
  $("length-explain").textContent = LENGTHS[state.length].explain;
  $("perstop-explain").textContent = PER_STOP_EXPLAIN[state.perStop];
  $("pace-explain").textContent = PACES[state.pace].explain;
  renderSummaries();
  for (const which of ["start", "end"]) {
    places[which].input.value = state[which] ? state[which].label : "";
    places[which].lastQuery = places[which].input.value;
  }
  for (const id of recall("w3b-open") || []) {
    if (SECTIONS.includes(id)) $(id).open = true;
  }
  const support = liveSupport();
  if (support) {
    $("live-toggle").disabled = true;
    $("live-pitch").textContent = support;
  }
}

function frame() {
  requestAnimationFrame(frame);
  if (!state.playing) return;
  const position = player.position();
  if (!position) return;
  if (state.playing === "spot") {
    highlightSpot(position.ending ? -1 : position.info.which);
    return;
  }
  renderPlayhead(position);
  if (state.playing === "route") renderSongInfo(position);
  // A small hop of the marker as each turn begins.
  const bar = position.ending ? null : position.bar;
  if (bar !== shownBar) {
    shownBar = bar;
    if (bar !== null && position.info.birds.length) {
      const el = playheadEl;
      el.classList.remove("hit");
      void el.offsetWidth;
      el.classList.add("hit");
    }
  }
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

async function main() {
  const missing = ["ol", "olms", "proj4", "h3", "Tone"].filter((name) => !(name in window));
  if (missing.length) throw new Error("Some of the page’s libraries didn’t load. Check your connection and reload.");
  const fromLink = decodeHash(location.hash);
  Object.assign(state, fromLink);
  // A route that arrived in a link is already out there.
  state.pathShared = Boolean(fromLink.path);
  syncControls();
  bindControls();
  const catalogue = await loadBirds("./data/birds.json");
  $("geomodel-version").textContent = `geomodel ${(catalogue.geomodel || []).join(", ")}`;
  if (catalogue.missing != null) $("missing-count").textContent = catalogue.missing.toLocaleString();
  setBirdSet(state.set);
  player.setPace(pace());
  initMap();
  setMarker("start");
  setMarker("end");
  renderRoute();
  rebuildRoute({ fit: false }).then(() => {
    fitRoute(false);
    if (fromLink.path || (fromLink.start && fromLink.end)) showArrival();
  });
  requestAnimationFrame(frame);
  $("loading").classList.add("done");
  try { sessionStorage.removeItem("w3b-refreshed"); } catch (error) { /* private mode */ }
  $("notice").showModal();
}

main().catch((error) => {
  console.error(error);
  $("loading").classList.add("failed");
  $("loading-text").textContent = error.message || "Something went wrong while loading.";
  const retry = document.createElement("button");
  retry.className = "button";
  retry.textContent = "Reload";
  retry.addEventListener("click", () => {
    // Drop the link's settings too, in case they are what broke.
    history.replaceState(null, "", location.pathname);
    location.reload();
  });
  $("loading-text").after(retry);
});
