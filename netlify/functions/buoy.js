/**
 * NEXUS EYE v0.4.10 — BUOY proxy (server function) · original NEXUS architecture
 * NOAA National Data Buoy Center "latest observations" text file (keyless, public):
 *   https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt  (~every 5–60 min per station)
 * The NDBC host sends no CORS header, so the browser cannot read it directly — this function
 * fetches it server-side, parses it, and returns compact JSON. 15 min cache · same-origin CORS like fire.js.
 * Never invents a station or a value: "MM" (missing) stays null; rows without a valid position or a
 * valid observation time are dropped and counted. Upstream failure → 502 {ok:false, error, message}
 * (or the last-good cache flagged stale). 429 → 429 with Retry-After.
 * Source-time proof: every station carries its own UTC observation time; the payload also reports the
 * upstream Last-Modified time, plus newest / median / oldest observation times.
 */
export const config = { path: "/api/buoy" };

const NDBC = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt";
const CACHE_MS = 15 * 60 * 1000;
const FUTURE_MS = 0; /* no future observation is accepted */
const MIN_ROWS = 1;
const UA = "NEXUS-EYE/0.4.10 (DoubleA; public-demo)";
const REQUIRED = ["STN", "LAT", "LON", "YYYY", "MM", "DD", "hh", "mm"];
/* value columns → output key (units are in the payload's `units`) */
const VALUES = [
  ["WDIR", "wdir"], ["WSPD", "wspd"], ["GST", "gst"], ["WVHT", "wvht"], ["DPD", "dpd"], ["APD", "apd"],
  ["MWD", "mwd"], ["PRES", "pres"], ["PTDY", "ptdy"], ["ATMP", "atmp"], ["WTMP", "wtmp"], ["DEWP", "dewp"],
  ["VIS", "vis"], ["TIDE", "tide"],
];
/* sane physical ranges — anything outside is treated as missing, never clamped */
const RANGE = {
  wdir: [0, 360], wspd: [0, 100], gst: [0, 120], wvht: [0, 30], dpd: [0, 40], apd: [0, 40], mwd: [0, 360],
  pres: [850, 1090], ptdy: [-30, 30], atmp: [-60, 60], wtmp: [-5, 40], dewp: [-60, 40], vis: [0, 100], tide: [-30, 30],
};

let cache = { at: 0, payload: null };
let hold = { until: 0, status: 502, body: null };

function corsHeaders(req) {
  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin") || "";
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60, s-maxage=900",
    "X-Nexus-Eye": "buoy-v0.4.10",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Retry-After",
  };
  if (!origin) {
    h["Access-Control-Allow-Origin"] = host ? `https://${host}` : "'self'";
  } else {
    try {
      const o = new URL(origin);
      if (o.host === host) {
        h["Access-Control-Allow-Origin"] = origin;
        h["Vary"] = "Origin";
      } else {
        h["X-Nexus-CORS"] = "cross-origin-denied";
      }
    } catch {
      h["X-Nexus-CORS"] = "bad-origin";
    }
  }
  return h;
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function num(tok) {
  if (tok == null) return null;
  const s = String(tok).trim();
  if (!s || s === "MM" || !/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* Parse the fixed whitespace-separated table. Throws on a malformed header (no partial guessing). */
export function parseLatestObs(text, now) {
  const lines = String(text || "").split(/\r?\n/);
  const hdrLine = lines.find((l) => /^#\s*STN\b/.test(l));
  if (!hdrLine) throw new Error("malformed NDBC file: header row missing");
  const hdr = hdrLine.replace(/^#\s*/, "").trim().split(/\s+/);
  for (const k of REQUIRED) if (!hdr.includes(k)) throw new Error("malformed NDBC file: column " + k + " missing");
  /* MM appears twice (month column and nothing else in the header); YYYY MM DD hh mm are positional */
  const ix = (k) => hdr.indexOf(k);
  const iStn = ix("STN"), iLat = ix("LAT"), iLon = ix("LON"), iY = ix("YYYY"), iMo = ix("MM"), iD = ix("DD"), iH = ix("hh"), iMi = ix("mm");
  const vIx = VALUES.map(([col, key]) => [hdr.indexOf(col), key]);
  const stats = { rows: 0, kept: 0, noPosition: 0, badTime: 0, future: 0, badRow: 0, dupe: 0 };
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;
    stats.rows++;
    const c = line.trim().split(/\s+/);
    if (c.length !== hdr.length) { stats.badRow++; continue; }
    const id = c[iStn];
    if (!/^[A-Za-z0-9]{3,8}$/.test(id)) { stats.badRow++; continue; }
    const lat = num(c[iLat]), lon = num(c[iLon]);
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) { stats.noPosition++; continue; }
    const Y = num(c[iY]), Mo = num(c[iMo]), D = num(c[iD]), H = num(c[iH]), Mi = num(c[iMi]);
    if (![Y, Mo, D, H, Mi].every((v) => v != null && Number.isInteger(v)) ||
        Mo < 1 || Mo > 12 || D < 1 || D > 31 || H < 0 || H > 23 || Mi < 0 || Mi > 59) { stats.badTime++; continue; }
    const t = Date.UTC(Y, Mo - 1, D, H, Mi);
    const back = Number.isFinite(t) ? new Date(t) : null;
    if (!back || back.getUTCFullYear() !== Y || back.getUTCMonth() !== Mo - 1 || back.getUTCDate() !== D || back.getUTCHours() !== H || back.getUTCMinutes() !== Mi) { stats.badTime++; continue; }
    if (t - now > FUTURE_MS) { stats.future++; continue; }
    if (seen.has(id.toUpperCase())) { stats.dupe++; continue; }
    seen.add(id.toUpperCase());
    const row = { id: id.toUpperCase(), lat: +lat.toFixed(3), lon: +lon.toFixed(3), t: new Date(t).toISOString() };
    for (const [i, key] of vIx) {
      if (i < 0) continue;
      const v = num(c[i]);
      const r = RANGE[key];
      if (v != null && (!r || (v >= r[0] && v <= r[1]))) row[key] = v;
    }
    out.push(row);
  }
  stats.kept = out.length;
  return { stations: out, stats };
}

function obsSpan(stations) {
  const ts = stations.map((s) => Date.parse(s.t)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ts.length) return { newest: null, median: null, oldest: null };
  const mid = ts.length >> 1;
  const med = ts.length % 2 ? ts[mid] : Math.round((ts[mid - 1] + ts[mid]) / 2);
  return { newest: new Date(ts[ts.length - 1]).toISOString(), median: new Date(med).toISOString(), oldest: new Date(ts[0]).toISOString() };
}

function retryAfterSeconds(raw, now) {
  const s = String(raw || "").trim();
  const n = /^\d+$/.test(s) ? +s : Math.ceil((Date.parse(s) - now) / 1000);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

export default async (req) => {
  const headers = corsHeaders(req);
  const noStore = { ...headers, "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return json(405, { ok: false, error: "method" }, noStore);

  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin") || "";
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return json(403, { ok: false, error: "cors", message: "same-origin only" }, noStore);
    } catch {
      return json(403, { ok: false, error: "cors" }, noStore);
    }
  }

  const now = Date.now();
  if (now < hold.until) {
    const h = { ...noStore, "Retry-After": String(Math.ceil((hold.until - now) / 1000)) };
    if (cache.payload && hold.status !== 429) return json(200, { ...cache.payload, cached: true, stale: true,
      error: hold.body.message, age_ms: now - cache.at }, h);
    return json(hold.status, hold.body, h);
  }
  if (cache.payload && now >= cache.at && now - cache.at < CACHE_MS) {
    return json(200, { ...cache.payload, cached: true, age_ms: now - cache.at }, noStore);
  }

  try {
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
    const res = await fetch(NDBC, { headers: { Accept: "text/plain,*/*", "User-Agent": UA }, signal });
    if (!res.ok) {
      const status = res.status === 429 ? 429 : 502;
      const seconds = Math.max(CACHE_MS / 1000, res.headers.get("retry-after") ? retryAfterSeconds(res.headers.get("retry-after"), now) : CACHE_MS / 1000);
      const body = { ok: false, error: status === 429 ? "rate-limited" : "upstream", status: res.status, message: "NDBC HTTP " + res.status };
      hold = { until: now + seconds * 1000, status, body };
      const h = { ...noStore, "Retry-After": String(seconds) };
      if (cache.payload && status !== 429) return json(200, { ...cache.payload, cached: true, stale: true,
        error: body.message, upstream: res.status, age_ms: now - cache.at }, h);
      return json(status, body, h);
    }
    const text = await res.text();
    const { stations, stats } = parseLatestObs(text, now);
    if (stations.length < MIN_ROWS) throw new Error("malformed NDBC file: 0 stations with position and time");
    const lm = Date.parse(res.headers.get("last-modified") || "");
    const span = obsSpan(stations);
    const payload = {
      ok: true,
      source: "ndbc-latest-obs",
      sourceName: "NOAA National Data Buoy Center · latest observations",
      sourceUrl: NDBC,
      pulledAt: new Date(now).toISOString(),
      sourceModified: Number.isFinite(lm) && lm <= now + FUTURE_MS ? new Date(lm).toISOString() : null,
      obsNewest: span.newest,
      obsMedian: span.median,
      obsOldest: span.oldest,
      count: stations.length,
      stats,
      units: { wdir: "degT", wspd: "m/s", gst: "m/s", wvht: "m", dpd: "s", apd: "s", mwd: "degT", pres: "hPa", ptdy: "hPa",
        atmp: "degC", wtmp: "degC", dewp: "degC", vis: "nmi", tide: "ft" },
      stations,
      cached: false,
    };
    hold = { until: 0, status: 502, body: null };
    cache = { at: now, payload };
    return json(200, payload, headers);
  } catch (err) {
    const msg = err && err.name === "TimeoutError" ? "NDBC timeout" : String((err && err.message) || err);
    const body = { ok: false, error: /malformed/.test(msg) ? "malformed" : "fetch", message: msg };
    hold = { until: now + CACHE_MS, status: 502, body };
    const h = { ...noStore, "Retry-After": String(CACHE_MS / 1000) };
    if (cache.payload) return json(200, { ...cache.payload, cached: true, stale: true, error: msg, age_ms: now - cache.at }, h);
    return json(502, body, h);
  }
};
