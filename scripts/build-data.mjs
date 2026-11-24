// Builds data/countries.geojson from two openly licensed datasets:
//  - Natural Earth 1:110m admin-0 boundaries (public domain) via the `world-atlas` npm package
//  - mledoze/countries metadata (ODbL) via the `world-countries` npm package
// Run: npm install && node scripts/build-data.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import { feature } from "topojson-client";
const require = createRequire(import.meta.url);
const topo = require("world-atlas/countries-110m.json");
const meta = require("world-countries");

// Rings that cross the 180° meridian (Russia, Fiji) jump from +180 to −180 and draw stripes
// across a flat Leaflet map. "Unwrapping" keeps every step < 180° so the ring stays continuous.
const unwrapRing = ring => {
  const out = [ring[0].slice()];
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0];
    const prev = out[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, ring[i][1]]);
  }
  // keep the polygon on the side where most of it lies
  const mean = out.reduce((s, p) => s + p[0], 0) / out.length;
  return mean < -180 ? out.map(([x, y]) => [x + 360, y]) : out;
};
const unwrapGeom = g => g.type === "Polygon"
  ? { type: g.type, coordinates: g.coordinates.map(unwrapRing) }
  : { type: g.type, coordinates: g.coordinates.map(poly => poly.map(unwrapRing)) };
const byNum = new Map(meta.map(c => [c.ccn3, c]));
const cap = s => s.charAt(0).toLocaleUpperCase("tr-TR") + s.slice(1);
const round = a => Array.isArray(a[0]) ? a.map(round) : [Math.round(a[0] * 100) / 100, Math.round(a[1] * 100) / 100];

const fc = feature(topo, topo.objects.countries);
const out = { type: "FeatureCollection", features: [] };
for (const f of fc.features) {
  const m = byNum.get(f.id);
  if (!m || m.region === "Antarctic" || !f.geometry) continue;
  out.features.push({
    type: "Feature",
    properties: {
      id: m.cca3, iso2: m.cca2,
      name: m.name.common,
      nameTr: cap(m.translations?.tur?.common || m.name.common),
      capital: (m.capital || [])[0] || "-",
      region: m.region,
      subregion: m.subregion || "",
      area: Math.round(m.area),
      flag: m.flag
    },
    geometry: (g => ({ type: g.type, coordinates: round(g.coordinates) }))(unwrapGeom(f.geometry))
  });
}
fs.writeFileSync("data/countries.geojson", JSON.stringify(out));
// Same data as a script so the game also runs when index.html is opened directly (file://)
fs.writeFileSync("data/countries.js", "window.COUNTRIES_GEOJSON = " + JSON.stringify(out) + ";\n");
console.log(`Wrote ${out.features.length} countries`);
