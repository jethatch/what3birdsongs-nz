// Whether a set of recordings may be mixed into one file, and under what
// licence the mix would then have to go.
//
// The recordings carry Creative Commons licences ("by", "by-nc", "by-sa",
// "by-nc-sa", "cc0"; nothing "no derivatives" is used at all). A song made
// from them is treated as an adaptation of each, which is the cautious
// reading: share-alike recordings then require the song to carry their
// licence, and two different share-alike licences, or "by-sa" together with
// anything non-commercial, can't both be honoured.

const NAMES = {
  "cc0": "CC0",
  "by": "CC BY 4.0",
  "by-nc": "CC BY-NC 4.0",
  "by-sa": "CC BY-SA 4.0",
  "by-nc-sa": "CC BY-NC-SA 4.0",
};
// What each licence lets the person downloading do, in a sentence.
const PLAIN = {
  "cc0": "anyone may use it for anything.",
  "by": "you may share and adapt it, for any purpose, crediting the recordists.",
  "by-nc": "you may share and adapt it, crediting the recordists, but not for commercial purposes.",
  "by-sa": "you may share and adapt it, crediting the recordists and sharing anything you make from it under the same licence.",
  "by-nc-sa": "you may share and adapt it, crediting the recordists, not for commercial purposes, and sharing anything you make from it under the same licence.",
};

// "by-nc-sa 4.0" -> "by-nc-sa"
function kind(code) {
  return String(code || "").split(" ")[0].toLowerCase();
}

// licences: the recordings' licence codes. Returns { ok, licence, why }.
export function combine(licences) {
  const kinds = new Set(licences.map(kind));
  for (const k of kinds) {
    if (!(k in NAMES)) return { ok: false, why: `one recording has a licence this page doesn’t know how to combine (${k || "none"})` };
  }
  const nc = [...kinds].some((k) => k.includes("nc"));
  const sa = kinds.has("by-sa");
  const ncsa = kinds.has("by-nc-sa");
  if (sa && nc) {
    return { ok: false, why: "it mixes a share-alike recording with non-commercial ones, and no single licence honours both" };
  }
  const licence = ncsa ? "by-nc-sa" : sa ? "by-sa" : nc ? "by-nc" : kinds.has("by") ? "by" : "cc0";
  return { ok: true, licence: NAMES[licence], code: licence, plain: PLAIN[licence], url: licenceUrl(licence === "cc0" ? "cc0" : `${licence} 4.0`) };
}

export function licenceName(code) {
  const [k, version] = String(code || "").split(" ");
  if (k === "cc0") return "CC0";
  return `CC ${k.toUpperCase()}${version ? ` ${version}` : ""}`;
}

export function licenceUrl(code) {
  const [k, version] = String(code || "").split(" ");
  if (k === "cc0") return "https://creativecommons.org/publicdomain/zero/1.0/";
  return `https://creativecommons.org/licenses/${k}/${version || "4.0"}/`;
}
