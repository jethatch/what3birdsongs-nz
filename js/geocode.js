// Free, keyless place search in Aotearoa New Zealand. Nominatim
// (OpenStreetMap) first, Photon (Komoot) if Nominatim is unreachable. Both
// allow browser requests.
// Nominatim's usage policy asks for at most one request a second and no
// search-as-you-type, so lookups only happen when the user submits.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const PHOTON_URL = "https://photon.komoot.io/api/";
const MIN_GAP_MS = 1100;
const TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;

const cache = new Map();
let lastRequestAt = 0;

// "-41.29, 174.78", "-41.29 174.78", "41.29S 174.78E". Returns null for text
// that isn't a pair of numbers, and { error } for a pair that's off the globe.
export function parseLatLng(text) {
  const match = text.trim().match(
    /^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/i,
  );
  if (!match) return null;
  let lat = parseFloat(match[1]);
  let lng = parseFloat(match[3]);
  if (match[2] && match[2].toUpperCase() === "S") lat = -Math.abs(lat);
  if (match[4] && match[4].toUpperCase() === "W") lng = -Math.abs(lng);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { error: "That looks like coordinates, but latitude runs from -90 to 90 and longitude from -180 to 180." };
  }
  return { lat, lng };
}

export function formatLatLng(lat, lng) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

async function fetchJSON(url, signal) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  if (signal) signal.addEventListener("abort", onAbort);
  try {
    const response = await fetch(url, { signal: timeout.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// "Kaikōura, Kaikōura District, Canterbury, New Zealand / Aotearoa" -> "Kaikōura, Canterbury"
function shorten(displayName) {
  const parts = displayName.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 2) return parts.join(", ");
  const region = parts.length > 3 ? parts[parts.length - 2] : parts[parts.length - 1];
  return /^\d/.test(region) ? `${parts[0]}, ${parts[parts.length - 1]}` : `${parts[0]}, ${region}`;
}

async function searchNominatim(query, signal) {
  // Reserve the next free slot so overlapping lookups queue up.
  const slot = Math.max(Date.now(), lastRequestAt + MIN_GAP_MS);
  lastRequestAt = slot;
  if (slot > Date.now()) await new Promise((resolve) => setTimeout(resolve, slot - Date.now()));
  const params = new URLSearchParams({ format: "jsonv2", limit: MAX_RESULTS, q: query, countrycodes: "nz" });
  const rows = await fetchJSON(`${NOMINATIM_URL}?${params}`, signal);
  return rows.map((row) => ({
    lat: parseFloat(row.lat),
    lng: parseFloat(row.lon),
    label: shorten(row.display_name),
    detail: row.display_name,
  }));
}

async function searchPhoton(query, signal) {
  // Photon can't be limited to a country, so ask for places near the
  // middle of New Zealand first and keep only New Zealand's.
  const params = new URLSearchParams({ limit: 15, q: query, lat: -41.3, lon: 174.8 });
  const data = await fetchJSON(`${PHOTON_URL}?${params}`, signal);
  const inNZ = (data.features || []).filter((f) => (f.properties || {}).countrycode === "NZ");
  return inNZ.slice(0, MAX_RESULTS).map((feature) => {
    const p = feature.properties || {};
    const parts = [p.name, p.city, p.state, p.country].filter(Boolean);
    const unique = parts.filter((part, i) => parts.indexOf(part) === i);
    return {
      lat: feature.geometry.coordinates[1],
      lng: feature.geometry.coordinates[0],
      label: unique.slice(0, 2).join(", ") || query,
      detail: unique.join(", ") || query,
    };
  });
}

// Resolves to a list of candidates, best first; empty when nothing matches.
// Rejects only when no geocoder could be reached.
export async function geocode(query, signal) {
  const text = query.trim();
  const coords = parseLatLng(text);
  if (coords && coords.error) throw new Error(coords.error);
  if (coords) return [{ ...coords, label: formatLatLng(coords.lat, coords.lng), detail: "Coordinates" }];

  const key = text.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let results;
  try {
    results = await searchNominatim(text, signal);
  } catch (error) {
    if (signal && signal.aborted) throw error;
    try {
      results = await searchPhoton(text, signal);
    } catch (fallbackError) {
      if (signal && signal.aborted) throw fallbackError;
      throw new Error("Place search is unreachable right now. Check your connection, or click the map to drop a pin.");
    }
  }
  results = results.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  cache.set(key, results);
  return results;
}
