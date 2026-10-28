// The map, in OpenLayers: basemap, route layers, pins, the playhead, the
// spot pop-up and the Chatham Islands inset. The rest of the app talks to it
// only in latitude and longitude, through the object createMapView returns.

import { PROJECTION, RESOLUTIONS, fillBasemap } from "./basemap.js";

const toMap = (lng, lat) => ol.proj.fromLonLat([lng, lat], PROJECTION);
const toLngLat = (xy) => ol.proj.toLonLat(xy, PROJECTION);
const geojson = new ol.format.GeoJSON({ dataProjection: "EPSG:4326", featureProjection: PROJECTION });

// The main islands with Stewart Island/Rakiura, and the Chatham Islands
// (Rēkohu/Wharekauri), in longitude and latitude.
const MAINLAND = [166.2, -47.4, 178.7, -34.1];
const CHATHAMS = [-177.2, -44.6, -175.7, -43.6];
const CHATHAMS_CENTRE = [-176.45, -44.05];
const mainlandExtent = ol.proj.transformExtent(MAINLAND, "EPSG:4326", PROJECTION);
const chathamsExtent = ol.extent.applyTransform(CHATHAMS, ol.proj.getTransform("EPSG:4326", PROJECTION), undefined, 8);
const wholeExtent = ol.extent.extend(ol.extent.clone(mainlandExtent), chathamsExtent);
const MAX_ZOOM = 19; // about 15 cm a pixel
// The grid's zoom levels, down to MAX_ZOOM. (With a list of resolutions,
// OpenLayers takes its zoom limits as whole positions in the list.)
const VIEW_RESOLUTIONS = RESOLUTIONS.slice(0, MAX_ZOOM + 1);

function routeStyles(colours) {
  const fill = (color, opacity) => new ol.style.Fill({ color: ol.color.asString([...ol.color.asArray(color).slice(0, 3), opacity]) });
  const stroke = (color, width, opacity = 1) =>
    new ol.style.Stroke({ color: ol.color.asString([...ol.color.asArray(color).slice(0, 3), opacity * (ol.color.asArray(color)[3] ?? 1)]), width, lineCap: "round", lineJoin: "round" });
  return {
    stop: new ol.style.Style({ fill: fill(colours.hex, colours.hexOpacity), stroke: stroke(colours.hex, 1.4, 0.9) }),
    played: new ol.style.Style({ fill: fill(colours.played, 0.24), stroke: stroke(colours.hex, 1.4, 0.9) }),
    current: new ol.style.Style({ fill: fill(colours.current, 0.7), stroke: stroke(colours.hex, 2.5) }),
    track: [
      new ol.style.Style({ stroke: stroke(colours.casing, 6, 0.6) }),
      new ol.style.Style({ stroke: stroke(colours.track, 3) }),
    ],
    travelled: new ol.style.Style({ stroke: stroke(colours.played, 3.5) }),
  };
}

export function createMapView({ target, inset: insetTarget, theme, colours, onClick, onUserMove, onLocate, onInset }) {
  const stops = new ol.source.Vector();
  const track = new ol.source.Vector();
  const travelled = new ol.source.Vector();
  let styles = routeStyles(colours);
  const progress = { played: -1, current: -2 };

  // Our layers get their own canvas (className), so the dark theme's filter
  // on the basemap leaves the route colours true.
  const routeLayers = () => [
    new ol.layer.Vector({
      source: stops,
      className: "w3b-overlay",
      style: (feature) => {
        const i = feature.get("i");
        return i === progress.current ? styles.current : i < progress.played ? styles.played : styles.stop;
      },
    }),
    new ol.layer.Vector({ source: track, className: "w3b-overlay", style: () => styles.track }),
    new ol.layer.Vector({ source: travelled, className: "w3b-overlay", style: () => styles.travelled }),
  ];

  const basemap = new ol.layer.Group();
  const view = new ol.View({
    projection: PROJECTION,
    resolutions: VIEW_RESOLUTIONS,
    center: ol.extent.getCenter(mainlandExtent),
    zoom: 5,
    extent: wholeExtent,
    constrainOnlyCenter: true,
    showFullExtent: true,
    enableRotation: false,
  });
  const located = new ol.control.Control({ element: locateButton() });
  const map = new ol.Map({
    target,
    view,
    layers: [basemap, ...routeLayers()],
    controls: [
      new ol.control.Zoom(),
      located,
      new ol.control.Attribution({ collapsible: true, collapsed: true }),
    ],
    interactions: ol.interaction.defaults.defaults({ altShiftDragRotate: false, pinchRotate: false }),
  });

  // The map may be created before its box has a size (the page is still
  // laying out). Anything that needs the size waits for one: the first view
  // of the islands, and a fit asked for in the meantime.
  const sized = () => {
    const size = map.getSize();
    return Boolean(size && size[0] > 0 && size[1] > 0);
  };
  let pendingFit = () => view.fit(mainlandExtent, { padding: [20, 20, 20, 20] });
  let syncInset = null; // set once the inset exists

  // No zooming out past the islands: the furthest view is the mainland
  // filling the map. Recomputed when the map changes size.
  function onSize() {
    if (!sized()) return;
    const resolution = view.getResolutionForExtent(mainlandExtent, map.getSize()) * 1.08;
    view.setMinZoom(Math.max(0, Math.floor(view.getZoomForResolution(resolution))));
    if (syncInset) syncInset();
    if (pendingFit) {
      const fit = pendingFit;
      pendingFit = null;
      fit();
    }
  }
  map.on("change:size", onSize);
  map.updateSize();
  onSize();

  // The Chatham Islands in a corner, as on most maps of New Zealand.
  // Clicking it takes the main map there; it hides while the Chathams are
  // already in view.
  const insetBasemap = new ol.layer.Group();
  const inset = new ol.Map({
    target: insetTarget,
    controls: [],
    interactions: [],
    layers: [insetBasemap, ...routeLayers()],
    view: new ol.View({ projection: PROJECTION, resolutions: RESOLUTIONS, center: toMap(...CHATHAMS_CENTRE), zoom: 6.4 }),
  });
  const insetBox = document.getElementById(insetTarget);
  insetBox.addEventListener("click", () => onInset && onInset());
  insetBox.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (onInset) onInset();
    }
  });
  syncInset = () => {
    if (sized()) insetBox.hidden = ol.extent.intersects(view.calculateExtent(map.getSize()), chathamsExtent);
  };
  view.on(["change:center", "change:resolution"], syncInset);

  const ready = Promise.all([fillBasemap(basemap, theme), fillBasemap(insetBasemap, theme)]);
  ready.catch((error) => console.warn("Basemap:", error.message));

  map.on("singleclick", (event) => {
    const [lng, lat] = toLngLat(event.coordinate);
    onClick(lat, lng);
  });
  map.on("pointerdrag", () => onUserMove && onUserMove());

  function locateButton() {
    const box = document.createElement("div");
    box.className = "ol-unselectable ol-control w3b-locate";
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Show where I am";
    button.setAttribute("aria-label", "Show where I am");
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="8" fill="none"/></svg>';
    button.addEventListener("click", () => {
      if (!navigator.geolocation) return;
      button.classList.add("busy");
      navigator.geolocation.getCurrentPosition(
        (fix) => {
          button.classList.remove("busy");
          const { latitude: lat, longitude: lng } = fix.coords;
          api.goTo(lat, lng, { metresPerPixel: 4 });
          if (onLocate) onLocate(lat, lng);
        },
        () => button.classList.remove("busy"),
        { enableHighAccuracy: true, timeout: 15000 },
      );
    });
    box.append(button);
    return box;
  }

  // Pins: overlays that can be dragged with mouse, pen or finger. Each is
  // made once and shown or hidden after that.
  const pins = {};
  const pinDrop = {};
  function pinOverlay(which, element) {
    const overlay = new ol.Overlay({ element, positioning: "bottom-center", stopEvent: true });
    element.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      const before = overlay.getPosition();
      let moved = false;
      const move = (e) => {
        moved = true;
        overlay.setPosition(map.getEventCoordinate(e));
      };
      const end = (e) => {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", end);
        element.removeEventListener("pointercancel", end);
        if (!moved) return;
        if (e.type === "pointercancel") {
          overlay.setPosition(before);
          return;
        }
        const [lng, lat] = toLngLat(map.getEventCoordinate(e));
        pinDrop[which](lat, lng);
      };
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", end);
      element.addEventListener("pointercancel", end);
    });
    map.addOverlay(overlay);
    return overlay;
  }

  let playhead = null;
  let popup = null;

  function animate(options, duration) {
    view.cancelAnimations();
    if (duration) view.animate({ ...options, duration });
    else {
      if (options.center) view.setCenter(options.center);
      if (options.resolution) view.setResolution(view.getConstrainedResolution(options.resolution));
    }
  }

  const api = {
    ready,

    setColours(next) {
      styles = routeStyles(next);
      for (const m of [map, inset]) m.getLayers().forEach((layer) => layer.changed());
    },

    setTheme(next, nextColours) {
      api.setColours(nextColours);
      Promise.all([fillBasemap(basemap, next), fillBasemap(insetBasemap, next)])
        .catch((error) => console.warn("Basemap:", error.message));
    },

    // stopsGeoJSON: polygons with properties.i; trackCoords: [[lng, lat], ...]
    setRoute(stopsGeoJSON, trackCoords) {
      stops.clear();
      track.clear();
      travelled.clear();
      if (stopsGeoJSON) stops.addFeatures(geojson.readFeatures(stopsGeoJSON));
      if (trackCoords && trackCoords.length > 1) {
        track.addFeature(new ol.Feature(new ol.geom.LineString(trackCoords.map(([lng, lat]) => toMap(lng, lat)))));
      }
    },

    setProgress(played, current) {
      if (progress.played === played && progress.current === current) return;
      progress.played = played;
      progress.current = current;
      stops.changed();
    },

    setTravelled(coords) {
      travelled.clear();
      if (coords.length > 1) {
        travelled.addFeature(new ol.Feature(new ol.geom.LineString(coords.map(([lng, lat]) => toMap(lng, lat)))));
      }
    },

    setPin(which, place, element, onDragEnd) {
      pinDrop[which] = onDragEnd;
      if (!pins[which]) {
        if (!place) return;
        pins[which] = pinOverlay(which, element);
      }
      pins[which].setPosition(place ? toMap(place.lng, place.lat) : undefined);
    },

    setPlayhead(lat, lng, element) {
      if (!playhead) {
        playhead = new ol.Overlay({ element, positioning: "center-center", stopEvent: false });
        map.addOverlay(playhead);
      }
      playhead.setPosition(toMap(lng, lat));
    },

    hidePlayhead() {
      if (playhead) map.removeOverlay(playhead);
      playhead = null;
    },

    playheadAt() {
      const xy = playhead && playhead.getPosition();
      if (!xy) return null;
      const [lng, lat] = toLngLat(xy);
      return { lat, lng };
    },

    center() {
      const [lng, lat] = toLngLat(view.getCenter());
      return { lat, lng };
    },

    // Moves the map to a point. `metresPerPixel` sets how close; with
    // `zoomInOnly` the map only ever zooms in to get there.
    goTo(lat, lng, { metresPerPixel, zoomInOnly = false, duration = 900 } = {}) {
      pendingFit = null;
      const options = { center: toMap(lng, lat) };
      if (metresPerPixel) {
        const current = view.getResolution();
        options.resolution = zoomInOnly ? Math.min(current, metresPerPixel) : metresPerPixel;
      }
      animate(options, duration);
    },

    jumpTo(lat, lng) {
      view.setCenter(toMap(lng, lat));
    },

    // points: [[lng, lat], ...]; padding in pixels.
    fit(points, padding, animated = true) {
      if (!points.length) return;
      const extent = ol.extent.boundingExtent(points.map(([lng, lat]) => toMap(lng, lat)));
      // Keep clear of the inset, if it is showing, in the top-left corner.
      const fit = () => {
        // Keep clear of the inset, but leave at least a fifth of the map
        // (a landscape phone is short) for the route itself.
        const [width, height] = map.getSize();
        let top = insetBox.hidden ? padding.top : Math.max(padding.top, insetBox.offsetTop + insetBox.offsetHeight + 16);
        let bottom = padding.bottom;
        const spare = height * 0.8;
        if (top + bottom > spare) {
          const scale = spare / (top + bottom);
          top *= scale;
          bottom *= scale;
        }
        const side = Math.min(padding.left + padding.right, width * 0.8) / 2;
        view.fit(extent, {
          padding: [top, side, bottom, side],
          maxZoom: MAX_ZOOM - 1,
          duration: animated ? 900 : 0,
        });
      };
      if (sized()) fit();
      else pendingFit = fit;
    },

    showChathams() {
      view.fit(chathamsExtent, { padding: [40, 40, 40, 40], duration: 900 });
    },

    // A pop-up holding `content` (an element). Returns { remove, getElement }.
    // `onClose` runs however it closes.
    openPopup(lat, lng, content, onClose) {
      if (popup) popup.remove();
      const box = document.createElement("div");
      box.className = "w3b-popup";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "w3b-popup-close";
      close.setAttribute("aria-label", "Close");
      close.textContent = "×";
      const body = document.createElement("div");
      body.className = "w3b-popup-content";
      body.append(close, content);
      const tip = document.createElement("div");
      tip.className = "w3b-popup-tip";
      box.append(body, tip);
      const overlay = new ol.Overlay({
        element: box,
        positioning: "bottom-center",
        offset: [0, -10],
        stopEvent: true,
        autoPan: { animation: { duration: 250 }, margin: 30 },
      });
      map.addOverlay(overlay);
      overlay.setPosition(toMap(lng, lat));
      const handle = {
        getElement: () => box,
        remove() {
          if (popup !== handle) return;
          popup = null;
          map.removeOverlay(overlay);
          if (onClose) onClose();
        },
      };
      close.addEventListener("click", () => handle.remove());
      popup = handle;
      return handle;
    },
  };
  return api;
}
