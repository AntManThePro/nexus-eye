/**
 * NEXUS EYE v0.4.13 — WHITE COUNTY, ARKANSAS all-source safety proxy (server function) · original NEXUS architecture
 * Fixed scope: White County, AR (NWS county ARC145 + forecast/fire zone ARZ033), centered on Searcy (35.25, -91.74).
 * RIVER AND LAKE FIRST. Every source is public and keyless, fetched server-side in parallel, each with its own
 * timeout, its own cache and its own last-good fallback (flagged stale, never presented as fresh):
 *   nws    NOAA/NWS active alerts for ARC145 + ARZ033 (api.weather.gov) — split into flood/hydro products and all others
 *   gauges NOAA NWS National Water Prediction Service (api.water.noaa.gov/nwps) — stage, flood categories, forecast crest
 *   usgs   USGS Water Data API (latest-continuous) — Little Red River near Dewey (just above Searcy) + backup for the NWPS gauges
 *   lake   USACE Little Rock District water-control data (cwms-data.usace.army.mil, office SWL) — Greers Ferry Lake level + release
 *   quake  USGS earthquake catalog (FDSN event service) — 60 km around Searcy (covers the whole county), last 7 days
 *   fire   NASA FIRMS MODIS C6.1 Global 24h CSV (same public file /api/fire uses) — hotspots inside the county bounding box, unthinned
 *   air    Open-Meteo air-quality API — MODELED US AQI at Searcy (not a monitor; EPA monitor feeds need an API key)
 *   spc    NOAA Storm Prediction Center Day 1 categorical convective outlook — the risk category over Searcy
 * Never invents a value: a missing number stays null; a failed source says so and shows nothing (or its last-good copy, stale:true).
 * Not an open proxy: no caller-supplied URLs, ids or coordinates. Only ?src= (a list of the names above) is accepted; anything else → 400.
 */
export const config = { path: "/api/wcalert" };

const VER = "0.4.13";
const UA = "NEXUS-EYE/" + VER + " (DoubleA; public-demo)";
const CENTER = { name: "Searcy, AR", lat: 35.25, lon: -91.74 };
const COUNTY = { name: "White County, Arkansas", fips: "05145", nwsCounty: "ARC145", nwsZones: ["ARZ033"],
  /* bounding box of the NWS ARC145 county polygon (api.weather.gov/zones/county/ARC145) */
  bbox: { w: -92.1196, s: 35.0212, e: -91.3458, n: 35.5342 } };
const QUAKE_KM = 60, QUAKE_DAYS = 7;

/* River gauges, upstream → downstream. lid = NWS NWPS id; usgs = USGS site (backup / extra). flood = NWPS categories
   copied 2026-11-28 — used ONLY when NWPS is unreachable, and labelled as such. */
/* Do not treat Searcy County zones (ARZ113/213/313) as White County — Searcy the city is in White County (ARC145 / ARZ033). */
const GAUGES = [
  { key: "judsonia", name: "Little Red River at Judsonia", note: "closest live NWS gauge to Searcy · just downstream", lid: "JUDA4", usgs: "07076634",
    flood: { action: 29, minor: 30, moderate: 33, major: 36 } },
  { key: "searcy", name: "Little Red River near Searcy", note: "USGS 07076620 has no current data (record ends 1996; last instantaneous value 1987). Judsonia is the live gauge for this reach.", lid: null, usgs: "07076620", retired: true },
  { key: "dewey", name: "Little Red River near Dewey", note: "just upstream of Searcy · USGS only · no NWS flood stage published", lid: null, usgs: "07076517" },
  { key: "georgetown", name: "White River at Georgetown", note: "White River, south-east White County", lid: "GEOA4", usgs: "07076750",
    flood: { action: 20.5, minor: 21, moderate: 24, major: 28 } },
  { key: "augusta", name: "White River near Augusta", note: "White River just east of White County (Woodruff County)", lid: "AUGA4", usgs: "07074850",
    flood: { action: 25.5, minor: 26, moderate: 34, major: 36 } },
];
const SRC_NAMES = ["nws", "gauges", "usgs", "lake", "quake", "fire", "air", "spc"];
const TTL = { nws: 2 * 60e3, gauges: 10 * 60e3, usgs: 10 * 60e3, lake: 15 * 60e3, quake: 5 * 60e3, fire: 12 * 60e3, air: 30 * 60e3, spc: 15 * 60e3 };
const FAIL_HOLD = 60e3;
const DEADLINE_MS = 8500;                     /* Netlify sync functions stop at 10 s */                          /* after a failure, don't re-hit that upstream for 60 s */
const FLOOD_RX = /flood|hydrologic/i;
const SEV = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };
const CAT_RANK = ["unknown", "below-action", "action", "minor", "moderate", "major"];
const SPC_RANK = { TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
const SPC_NAME = { TSTM: "General thunderstorms", MRGL: "Marginal risk", SLGT: "Slight risk", ENH: "Enhanced risk", MDT: "Moderate risk", HIGH: "High risk" };

const NWS_URL = "https://api.weather.gov/alerts/active?status=actual&zone=" + [COUNTY.nwsCounty, ...COUNTY.nwsZones].join(",");
const NWS_UP_URL = "https://api.weather.gov/alerts/active?status=actual&zone=ARC023,ARZ024"; /* Cleburne County — Greers Ferry Dam / Little Red headwaters */
const NWPS = "https://api.water.noaa.gov/nwps/v1/gauges/";
const USGS_URL = "https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?f=json&parameter_code=00065,00060&monitoring_location_id=" + GAUGES.map((g) => "USGS-" + g.usgs).join(",");
const CWMS = "https://cwms-data.usace.army.mil/cwms-data/";
const LAKE_TS = {
  elev: "GreersFerry_Dam-Headwater.Elev.Inst.1Hour.0.Decodes-rev",
  pctCons: "GreersFerry_Dam-Headwater.%-Conservation Pool.Inst.1Hour.0.CCP-Comp",
  pctFlood: "GreersFerry_Dam-Headwater.%-Flood Pool.Inst.1Hour.0.CCP-Comp",
  release: "GreersFerry_Dam.Flow-Res Out.Ave.1Hour.1Hour.Regi-Comp", /* official USACE outflow */
  tailwater: "GreersFerry_Dam-Tailwater.Flow.Inst.1Hour.0.CCP-Comp",
};
const LAKE_REF_FALLBACK = { topConservation: 462.04, topFlood: 487, topDam: 503, bottomNormal: 435, datum: "NGVD29", source: "USACE published pool limits" };
const QUAKE_BASE = "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&limit=50";
const FIRMS = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + CENTER.lat + "&longitude=" + CENTER.lon + "&current=us_aqi,pm2_5,pm10,ozone&timezone=UTC";
const SPC_URL = "https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson";

const cache = new Map();   /* src → { at, data, meta } last good */
const fails = new Map();   /* src → { at, error } last failure */

function corsHeaders(req) {
  const host = req.headers.get("host") || "", origin = req.headers.get("origin") || "";
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=30, s-maxage=60",
    "X-Nexus-Eye": "wcalert-v" + VER, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (!origin) h["Access-Control-Allow-Origin"] = host ? `https://${host}` : "'self'";
  else { try { if (new URL(origin).host === host) { h["Access-Control-Allow-Origin"] = origin; h["Vary"] = "Origin"; } else h["X-Nexus-CORS"] = "cross-origin-denied"; } catch { h["X-Nexus-CORS"] = "bad-origin"; } }
  return h;
}
const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers });
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const fin = (v) => (typeof v === "number" && Number.isFinite(v) && v > -999 ? v : null);
const clip = (s, n) => { const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

async function getJson(url, accept, ms) {
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms || 12000) : undefined;
  const res = await fetch(url, { headers: { Accept: accept || "application/json", "User-Agent": UA }, signal });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
async function getText(url, ms) {
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms || 20000) : undefined;
  const res = await fetch(url, { headers: { Accept: "text/csv,text/plain,*/*", "User-Agent": UA }, signal });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return { text: await res.text(), modified: Date.parse(res.headers.get("last-modified") || "") };
}
function friendly(err) {
  const m = String((err && err.message) || err || "error");
  if (err && err.name === "TimeoutError") return "timeout";
  return /^HTTP \d+$/.test(m) ? m : m.length > 80 ? "unreadable response" : m;
}

/* flood category from stage vs NWS thresholds — computed here so every gauge is judged the same way */
export function floodCategory(stage, f) {
  if (stage == null || !f) return "unknown";
  if (fin(f.major) != null && stage >= f.major) return "major";
  if (fin(f.moderate) != null && stage >= f.moderate) return "moderate";
  if (fin(f.minor) != null && stage >= f.minor) return "minor";
  if (fin(f.action) != null && stage >= f.action) return "action";
  return "below-action";
}

export function shapeAlert(f) {
  const p = (f && f.properties) || {};
  return { id: String(p.id || f.id || ""), event: clip(p.event, 80), severity: p.severity || "Unknown", urgency: p.urgency || "Unknown",
    certainty: p.certainty || "Unknown", headline: clip(p.headline, 240), area: clip(p.areaDesc, 200), sender: clip(p.senderName, 80),
    sent: p.sent || null, onset: p.onset || p.effective || null, ends: p.ends || p.expires || null, expires: p.expires || null,
    description: clip(p.description, 700), instruction: clip(p.instruction, 400), messageType: p.messageType || null,
    flood: FLOOD_RX.test(String(p.event || "")) };
}

/* ---- sources: each returns { data, obsTime? } or throws ---- */
const SOURCES = {
  async nws(now) {
    const inEffect = (a) => { const t = Date.parse(a.ends || a.expires || ""); return !Number.isFinite(t) || t > now; };
    const [white, up] = await Promise.all([
      getJson(NWS_URL, "application/geo+json", 12000),
      getJson(NWS_UP_URL, "application/geo+json", 12000).catch(() => null),
    ]);
    if (!white || !Array.isArray(white.features)) throw new Error("unreadable response");
    const seen = new Set(), all = [];
    for (const f of white.features) {
      const a = shapeAlert(f);
      if (!a.id || seen.has(a.id) || !inEffect(a)) continue;
      a.upstream = false; seen.add(a.id); all.push(a);
    }
    /* Cleburne / Greers Ferry: only flood and hydrologic products, tagged upstream, never mixed in as White County alerts */
    for (const f of (up && up.features) || []) {
      const a = shapeAlert(f);
      if (!a.id || seen.has(a.id) || !inEffect(a) || !a.flood) continue;
      a.upstream = true; seen.add(a.id); all.push(a);
    }
    all.sort((a, b) => (b.flood - a.flood) || ((a.upstream ? 0 : 1) - (b.upstream ? 0 : 1)) || (SEV[b.severity] || 0) - (SEV[a.severity] || 0) || String(b.sent).localeCompare(String(a.sent)));
    return { data: { flood: all.filter((a) => a.flood), other: all.filter((a) => !a.flood), feedUpdated: white.updated || null }, obsTime: Date.parse(white.updated || "") };
  },
  async gauges(now) {
    const out = [];
    for (const g of GAUGES.filter((x) => x.lid)) {
      const [meta, fc] = await Promise.all([getJson(NWPS + g.lid, null, 10000), getJson(NWPS + g.lid + "/stageflow/forecast", null, 10000).catch(() => null)]);
      const cats = (meta.flood && meta.flood.categories) || {};
      const flood = { action: fin(cats.action && cats.action.stage), minor: fin(cats.minor && cats.minor.stage),
        moderate: fin(cats.moderate && cats.moderate.stage), major: fin(cats.major && cats.major.stage) };
      const o = (meta.status && meta.status.observed) || {};
      const stage = fin(o.primary);
      let crest = null;
      if (fc && Array.isArray(fc.data)) {
        for (const p of fc.data) { const t = Date.parse(p.validTime), v = fin(p.primary); if (v == null || !(t > now)) continue; if (!crest || v > crest.stage) crest = { stage: v, t: iso(t) }; }
        if (crest) crest.category = floodCategory(crest.stage, flood);
      }
      out.push({ key: g.key, lid: g.lid, name: meta.name || g.name, note: g.note, units: "ft", stage, flow_kcfs: fin(o.secondary), obsTime: o.validTime || null,
        category: floodCategory(stage, flood), nwsCategory: o.floodCategory || null, flood, floodSource: "nwps",
        forecast: crest ? { crest, issued: fc.issuedTime || null } : null,
        page: "https://water.noaa.gov/gauges/" + g.lid.toLowerCase() });
    }
    const t = out.map((g) => Date.parse(g.obsTime)).filter(Number.isFinite);
    return { data: { gauges: out }, obsTime: t.length ? Math.min(...t) : NaN };
  },
  async usgs(now) {
    const d = await getJson(USGS_URL, "application/geo+json,application/json", 8000);
    if (!d || !Array.isArray(d.features)) throw new Error("unreadable response");
    const by = {};
    for (const f of d.features) {
      const p = f.properties || {};
      const site = String(p.monitoring_location_id || "").replace(/^USGS-/, "");
      const v = Number(p.value), t = Date.parse(p.time || "");
      if (!site || !Number.isFinite(v) || v <= -999 || !Number.isFinite(t)) continue;
      by[site] = by[site] || {};
      if (p.parameter_code === "00065") { by[site].stage = v; by[site].stageTime = iso(t); }
      if (p.parameter_code === "00060") { by[site].flow_cfs = v; by[site].flowTime = iso(t); }
    }
    const LIVE_MS = 7 * 864e5;
    const sites = GAUGES.filter((g) => g.usgs).map((g) => {
      const r = by[g.usgs] || {};
      const stageT = Date.parse(r.stageTime || ""), flowT = Date.parse(r.flowTime || "");
      const latest = Math.max(Number.isFinite(stageT) ? stageT : 0, Number.isFinite(flowT) ? flowT : 0);
      const live = latest > 0 && now - latest < LIVE_MS;
      if (!live) {
        return { key: g.key, site: g.usgs, name: g.name, note: g.note, retired: !!g.retired, noCurrent: true,
          lastHistoric: latest ? iso(latest) : null, flood: g.flood || null, category: "unknown",
          page: "https://waterdata.usgs.gov/monitoring-location/" + g.usgs + "/" };
      }
      return { key: g.key, site: g.usgs, name: g.name, note: g.note, retired: false, noCurrent: false, ...r,
        /* USGS publishes no flood stage: these are the NWS categories copied 2026-11-28, used when NWPS is down */
        flood: g.flood || null, floodSource: g.flood ? "nwps-copy-2026-11-28" : null, category: g.flood ? floodCategory(r.stage == null ? null : r.stage, g.flood) : "unknown",
        page: "https://waterdata.usgs.gov/monitoring-location/" + g.usgs + "/" };
    });
    const t = sites.filter((s) => !s.noCurrent).map((s) => Date.parse(s.stageTime || s.flowTime)).filter(Number.isFinite);
    if (!t.length) throw new Error("no current readings");
    return { data: { sites }, obsTime: Math.max(...t) };
  },
  async lake(now) {
    const begin = new Date(now - 36 * 3600e3).toISOString();
    const series = async (name, units) => {
      const d = await getJson(CWMS + "timeseries?office=SWL&name=" + encodeURIComponent(name) + "&begin=" + begin + (units ? "&units=" + encodeURIComponent(units) : ""), "application/json;version=2", 12000);
      const v = (d.values || []).filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && fin(r[1]) != null && r[0] <= now);
      if (!v.length) return null;
      const last = v[v.length - 1], prev24 = v.find((r) => r[0] >= last[0] - 24 * 3600e3);
      return { value: last[1], t: iso(last[0]), units: d.units || units || null, change24h: prev24 && prev24 !== last ? +(last[1] - prev24[1]).toFixed(2) : null };
    };
    const [elev, pctCons, pctFlood, release, tailwater, levels] = await Promise.all([series(LAKE_TS.elev, "ft"), series(LAKE_TS.pctCons).catch(() => null),
      series(LAKE_TS.pctFlood).catch(() => null), series(LAKE_TS.release, "cfs").catch(() => null), series(LAKE_TS.tailwater, "cfs").catch(() => null),
      getJson(CWMS + "levels?office=SWL&unit=EN&level-id-mask=" + encodeURIComponent("GreersFerry_Dam.Elev-Pool*"), "application/json;version=2", 12000).catch(() => null)]);
    if (!elev) throw new Error("no current lake elevation");
    const ref = { datum: "NGVD29" };
    for (const l of (levels && levels.levels) || []) {
      const k = l["specified-level-id"]; const v = fin(l["constant-value"]) != null ? l["constant-value"] : l["seasonal-values"] && l["seasonal-values"][0] ? fin(l["seasonal-values"][0].value) : null;
      if (v == null) continue;
      if (k === "Top of Conservation") ref.topConservation = +v.toFixed(2);
      if (k === "Top of Flood") ref.topFlood = +v.toFixed(2);
      if (k === "Top of Dam") ref.topDam = +v.toFixed(2);
      if (k === "Bottom of Normal") ref.bottomNormal = +v.toFixed(2);
    }
    if (ref.topConservation == null || ref.topFlood == null) Object.assign(ref, LAKE_REF_FALLBACK, ref);
    const r2 = (x) => (x == null ? null : +x.toFixed(2));
    return { data: { name: "Greers Ferry Lake (Greers Ferry Dam, Heber Springs)", elev_ft: r2(elev.value), elevTime: elev.t, change24h_ft: elev.change24h,
      aboveConservation_ft: ref.topConservation != null ? r2(elev.value - ref.topConservation) : null,
      belowFlood_ft: ref.topFlood != null ? r2(ref.topFlood - elev.value) : null, ref,
      pctConservation: pctCons ? r2(pctCons.value) : null, pctFloodPoolUsed: pctFlood ? r2(pctFlood.value) : null,
      release_cfs: release ? Math.round(release.value) : null, releaseTime: release ? release.t : null,
      tailwater_cfs: tailwater ? Math.round(tailwater.value) : null,
      page: "https://water.usace.army.mil/overview/swl/locations/greersferry_dam" }, obsTime: Date.parse(elev.t) };
  },
  async quake(now) {
    const url = QUAKE_BASE + "&latitude=" + CENTER.lat + "&longitude=" + CENTER.lon + "&maxradiuskm=" + QUAKE_KM + "&starttime=" + new Date(now - QUAKE_DAYS * 864e5).toISOString().slice(0, 19);
    const d = await getJson(url, "application/json", 12000);
    if (!d || !Array.isArray(d.features)) throw new Error("unreadable response");
    const qs = d.features.map((f) => ({ id: f.id, mag: fin(f.properties.mag), place: clip(f.properties.place, 100), t: iso(f.properties.time),
      depth_km: f.geometry && Array.isArray(f.geometry.coordinates) ? fin(f.geometry.coordinates[2]) : null, url: f.properties.url || null,
      dist_km: f.geometry ? Math.round(km(CENTER.lat, CENTER.lon, f.geometry.coordinates[1], f.geometry.coordinates[0])) : null }));
    return { data: { radius_km: QUAKE_KM, days: QUAKE_DAYS, count: qs.length, maxMag: qs.reduce((m, q) => (q.mag != null && (m == null || q.mag > m) ? q.mag : m), null), quakes: qs.slice(0, 15) } };
  },
  async fire() {
    const { text, modified } = await getText(FIRMS, 20000);
    const lines = text.split(/\r?\n/);
    const hdr = (lines[0] || "").split(",").map((s) => s.trim().toLowerCase());
    const ix = (n) => hdr.indexOf(n);
    const iLat = ix("latitude"), iLon = ix("longitude");
    if (iLat < 0 || iLon < 0) throw new Error("unreadable response");
    const b = COUNTY.bbox, hits = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(","); const lat = +c[iLat], lon = +c[iLon];
      if (!(lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e)) continue;
      hits.push({ lat, lon, frp: fin(+c[ix("frp")]), conf: c[ix("confidence")] || null, date: c[ix("acq_date")] || null, time: c[ix("acq_time")] || null, sat: c[ix("satellite")] || null,
        dist_km: Math.round(km(CENTER.lat, CENTER.lon, lat, lon)) });
    }
    return { data: { window: "24h", area: "county bounding box", count: hits.length, fires: hits.slice(0, 25), fileModified: iso(modified) }, obsTime: modified };
  },
  async air() {
    const d = await getJson(AIR_URL, null, 10000);
    const c = d && d.current;
    if (!c) throw new Error("unreadable response");
    const aqi = fin(c.us_aqi);
    return { data: { modeled: true, us_aqi: aqi, category: aqiCat(aqi), pm2_5: fin(c.pm2_5), pm10: fin(c.pm10), ozone: fin(c.ozone), units: "µg/m³",
      time: c.time ? c.time + "Z" : null }, obsTime: Date.parse(c.time ? c.time + "Z" : "") };
  },
  async spc() {
    const d = await getJson(SPC_URL, "application/geo+json,application/json", 12000);
    if (!d || !Array.isArray(d.features)) throw new Error("unreadable response");
    let best = null, valid = null, expire = null, issued = null;
    for (const f of d.features) {
      const p = f.properties || {}; valid = valid || p.VALID_ISO || null; expire = expire || p.EXPIRE_ISO || null; issued = issued || p.ISSUE_ISO || null;
      if (SPC_RANK[p.LABEL] && inGeom(f.geometry, CENTER.lon, CENTER.lat) && (!best || SPC_RANK[p.LABEL] > SPC_RANK[best])) best = p.LABEL;
    }
    return { data: { day: 1, category: best, label: best ? SPC_NAME[best] : "No thunderstorm area", valid, expire, issued,
      page: "https://www.spc.noaa.gov/products/outlook/day1otlk.html" }, obsTime: Date.parse(issued || "") };
  },
};

function aqiCat(a) { if (a == null) return null; return a <= 50 ? "Good" : a <= 100 ? "Moderate" : a <= 150 ? "Unhealthy for sensitive groups" : a <= 200 ? "Unhealthy" : a <= 300 ? "Very unhealthy" : "Hazardous"; }
function km(a, b, c, d) { const R = 6371, r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function inRing(ring, x, y) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; }
export function inGeom(g, x, y) {
  if (!g) return false;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some((p) => Array.isArray(p) && p.length && inRing(p[0], x, y) && !p.slice(1).some((h) => inRing(h, x, y)));
}

async function runSource(name, now) {
  const c = cache.get(name), f = fails.get(name);
  if (c && now - c.at < TTL[name]) return { name, cached: true, ...c };
  if (f && now - f.at < FAIL_HOLD) return { name, cached: true, failed: true, error: f.error, ...(c || {}) };
  let timer = null;
  try {
    /* hard per-source deadline so one slow agency never holds the whole card past the function limit */
    const r = await Promise.race([SOURCES[name](now), new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })), DEADLINE_MS); })]);
    clearTimeout(timer);
    const entry = { at: now, data: r.data, obsTime: Number.isFinite(r.obsTime) ? iso(r.obsTime) : null };
    cache.set(name, entry); fails.delete(name);
    return { name, cached: false, ...entry };
  } catch (err) {
    clearTimeout(timer);
    const error = friendly(err);
    fails.set(name, { at: now, error });
    return { name, cached: false, failed: true, error, ...(c || {}) };
  }
}

const SOURCE_META = {
  nws: ["NOAA / National Weather Service · active alerts (ARC145 + ARZ033; Cleburne hydro upstream)", "https://www.weather.gov/lzk/"],
  gauges: ["NOAA NWS National Water Prediction Service · river gauges", "https://water.noaa.gov/"],
  usgs: ["USGS Water Data API · latest continuous values", "https://waterdata.usgs.gov/"],
  lake: ["USACE Little Rock District · water control data", "https://www.swl-wc.usace.army.mil/"],
  quake: ["USGS Earthquake Hazards Program · event catalog", "https://earthquake.usgs.gov/"],
  fire: ["NASA FIRMS · MODIS C6.1 24 h active fire", "https://firms.modaps.eosdis.nasa.gov/"],
  air: ["Open-Meteo air-quality API · modeled (CAMS), not a monitor", "https://open-meteo.com/en/docs/air-quality-api"],
  spc: ["NOAA Storm Prediction Center · Day 1 convective outlook", "https://www.spc.noaa.gov/"],
};

export function parseSrc(url) {
  const keys = [...url.searchParams.keys()];
  for (const k of keys) if (k !== "src" && k !== "_") return { error: "unknown parameter: " + clip(k, 20) };
  if (url.searchParams.has("_") && !/^\d{1,15}$/.test(url.searchParams.get("_"))) return { error: "bad _" };
  const raw = url.searchParams.get("src");
  if (raw == null || raw === "" || raw === "all") return { list: SRC_NAMES };
  const list = [...new Set(raw.split(","))];
  if (list.length > SRC_NAMES.length || !list.every((s) => SRC_NAMES.includes(s))) return { error: "src must be a comma list of " + SRC_NAMES.join(",") };
  return { list };
}

export default async (req) => {
  const headers = corsHeaders(req);
  const noStore = { ...headers, "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return json(405, { ok: false, error: "method" }, noStore);
  const host = req.headers.get("host") || "", origin = req.headers.get("origin") || "";
  if (origin && host) { try { if (new URL(origin).host !== host) return json(403, { ok: false, error: "cors", message: "same-origin only" }, noStore); } catch { return json(403, { ok: false, error: "cors" }, noStore); } }
  let url; try { url = new URL(req.url); } catch { return json(400, { ok: false, error: "bad-request" }, noStore); }
  const want = parseSrc(url);
  if (want.error) return json(400, { ok: false, error: "bad-input", message: want.error }, noStore);

  const now = Date.now();
  const results = await Promise.all(want.list.map((n) => runSource(n, now)));
  const sources = {};
  for (const r of results) {
    const [name, page] = SOURCE_META[r.name];
    sources[r.name] = { ok: !!r.data, stale: !!(r.failed && r.data), error: r.error || null, cached: !!r.cached, sourceName: name, sourcePage: page,
      pulledAt: r.at ? iso(r.at) : null, age_ms: r.at ? now - r.at : null, obsTime: r.obsTime || null, data: r.data || null };
  }
  const anyOk = results.some((r) => r.data);
  const nws = sources.nws && sources.nws.data;
  const gauges = sources.gauges && sources.gauges.data ? sources.gauges.data.gauges : [];
  const summary = {
    floodAlerts: nws ? nws.flood.length : null,
    otherAlerts: nws ? nws.other.length : null,
    worstRiver: gauges.length ? gauges.map((g) => g.category).sort((a, b) => CAT_RANK.indexOf(b) - CAT_RANK.indexOf(a))[0] : null,
  };
  const body = { ok: anyOk, source: "white-county-ar", version: VER, cached: results.every((r) => r.cached), pulledAt: iso(now),
    scope: { ...COUNTY, center: CENTER, quakeRadiusKm: QUAKE_KM }, summary, sources };
  /* LIVE data must not be held by a CDN longer than the shortest TTL; failures are never edge-cached */
  return json(anyOk ? 200 : 502, body, anyOk && !results.some((r) => r.failed) ? headers : noStore);
};
