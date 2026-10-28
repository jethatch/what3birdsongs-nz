// A live session: follow the device's position and turn it into stops, one
// per grid cell entered. The cells are far bigger than the ~1 m cells the
// chords come from, because a phone's idea of where it is wanders by many
// metres; the size also grows with speed so a drive isn't a blur of chords.
// Each stop stands at its cell's centre, so a cell sounds the same
// whoever walks into it and from whichever side.

import { haversineKm } from "./routing.js";

const MAX_USABLE_ACCURACY_M = 150;
const MAX_FIRST_FIX_ACCURACY_M = 100;
// Speeds, in metres per second, at which the pace changes: on foot below
// the first, on a bike below the second, driving in town below the third.
const PACE_LIMITS = [2.5, 7, 14];
const PACE_NAMES = ["walking pace", "cycling pace", "driving in town", "driving"];
const RES_SETTLE_MS = 8000;
const DWELL_MS = 3000;

// The pace (0 walking .. 3 driving) for a speed in metres per second. Each
// grid lists a cell size for each pace: roughly 50 m across on foot, 130 m
// on a bike, 350 m in town traffic and 900 m on the open road.
export function paceForSpeed(mps) {
  const pace = PACE_LIMITS.findIndex((limit) => mps < limit);
  return pace < 0 ? PACE_LIMITS.length : pace;
}

// The same, but reluctant to leave the current pace when the speed is only
// just over the line, so a steady jog at the boundary doesn't flip-flop.
function steadyPace(mps, current) {
  const wanted = paceForSpeed(mps);
  if (Math.abs(wanted - current) !== 1) return wanted;
  const limit = PACE_LIMITS[Math.min(wanted, current)];
  return Math.abs(mps - limit) < limit * 0.15 ? current : wanted;
}

export function paceName(pace) {
  return PACE_NAMES[pace] || "moving";
}

function formatAccuracy(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

export function liveSupport() {
  if (!("geolocation" in navigator)) return "This browser can’t share its location.";
  if (!window.isSecureContext) return "Location only works on a secure (https) page.";
  return "";
}

export class LiveSession {
  // onStop(stop) for each new cell, onFix(fix) for every usable position,
  // onError(message, fatal) when the browser can't give one.
  constructor(grid, { onStop, onFix, onError }) {
    this.grid = grid;
    this.onStop = onStop;
    this.onFix = onFix;
    this.onError = onError;
    this.stops = []; // { point: cell centre [lat, lng], res, time, entry }
    this.pace = 0;
    this.res = grid.liveRes[0];
    this.speed = 0;
    this.last = null;
    this.pendingPace = null;
    this.candidate = null;
    this.watch = null;
    this.wakeLock = null;
    this.onVisible = () => {
      if (document.visibilityState === "visible") this.keepAwake();
    };
  }

  start() {
    this.watch = navigator.geolocation.watchPosition(
      (position) => this.handle(position),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          this.onError("Location permission was refused, so there’s nothing to play. Allow location for this page and try again.", true);
        } else if (!this.stops.length) {
          this.onError("Still waiting for a location fix. It can take a moment, and works best outdoors.", false);
        }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    this.keepAwake();
    document.addEventListener("visibilitychange", this.onVisible);
  }

  stop() {
    if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.wakeLock) this.wakeLock.release().catch(() => {});
    this.wakeLock = null;
  }

  // Phones stop running the page when the screen locks, so hold it on.
  // The lock is dropped whenever the page is hidden and has to be re-taken.
  async keepAwake() {
    if (!("wakeLock" in navigator) || this.watch === null) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      // The session may have ended while the request was pending.
      if (this.watch === null) lock.release().catch(() => {});
      else this.wakeLock = lock;
    } catch (error) {
      // Refused (low battery, say): the session still works with the screen on.
    }
  }

  handle(position) {
    const { latitude: lat, longitude: lng, accuracy } = position.coords;
    const time = position.timestamp || Date.now();
    const fix = { point: [lat, lng], accuracy, time };
    // A wild guess is worse than no update, and worst of all as the place
    // the whole trip starts from.
    if (accuracy > (this.stops.length ? MAX_USABLE_ACCURACY_M : MAX_FIRST_FIX_ACCURACY_M)) {
      if (!this.stops.length) this.onError(`Waiting for a better fix. Right now it’s only good to ${formatAccuracy(accuracy)}.`, false);
      return;
    }

    if (this.last) {
      const seconds = (time - this.last.time) / 1000;
      // Many devices report no speed at all (null), so fall back to how far
      // the position moved.
      let speed = position.coords.speed;
      if (!(typeof speed === "number" && speed >= 0)) {
        speed = seconds > 0.5 ? (haversineKm(this.last.point, fix.point) * 1000) / seconds : null;
      }
      if (speed !== null) this.speed = this.speed * 0.7 + speed * 0.3;
    }
    this.last = fix;
    this.settleResolution(time);
    fix.speed = this.speed;
    fix.res = this.res;
    fix.pace = this.pace;

    const current = this.stops[this.stops.length - 1];
    if (!current) {
      this.addStop(fix);
    } else {
      const here = this.grid.cellAt(lat, lng, this.res);
      const there = this.grid.cellAt(current.point[0], current.point[1], this.res);
      // (After a change of cell size, "there" is the new-size cell
      // around the old stop.)
      if (here === there) {
        this.candidate = null;
      } else {
        if (!this.candidate || this.candidate.cell !== here) this.candidate = { cell: here, since: time, fixes: 0 };
        this.candidate.fixes++;
        // Standing near an edge, the position flickers across it. Count it
        // as a move only once it has stuck and is a real distance away.
        const settled = this.candidate.fixes >= 2 || time - this.candidate.since >= DWELL_MS;
        const movedKm = haversineKm(current.entry, fix.point);
        if (settled && movedKm > 0.6 * this.grid.spacingKm(this.res)) this.addStop(fix);
      }
    }
    this.onFix(fix);
  }

  // Change cell size only once the new pace has lasted a while, so a
  // red light or a sprint for the bus doesn't.
  settleResolution(time) {
    const wanted = steadyPace(this.speed, this.pace);
    if (wanted === this.pace) {
      this.pendingPace = null;
    } else if (!this.pendingPace || this.pendingPace.pace !== wanted) {
      this.pendingPace = { pace: wanted, since: time };
    } else if (time - this.pendingPace.since >= RES_SETTLE_MS) {
      this.pace = wanted;
      this.res = this.grid.liveRes[wanted];
      this.pendingPace = null;
      this.candidate = null;
    }
  }

  addStop(fix) {
    const cell = this.grid.cellAt(fix.point[0], fix.point[1], this.res);
    // `entry`, where the device actually was, is only for judging the next
    // move; it is never part of the route.
    const stop = { point: this.grid.centre(cell), res: this.res, time: fix.time, entry: fix.point };
    this.stops.push(stop);
    this.candidate = null;
    this.onStop(stop);
  }
}
