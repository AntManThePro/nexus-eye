/**
 * NEXUS EYE v0.4.7 — /api/air  (AIR LIVE proxy)
 *
 * Ported onto live v0.4.6 (drift fix / icons / egg / CITY tabs / PREV+NEXT). Same Texas-first adsb.lol contract as the staged v0.4.4.1-r2 / v0.4.6.3 hotfix.
 *
 * Why this changed (hotfix): the previous aircraft source blocks cloud-provider IP ranges, and this site's server
 * functions run in such a range, so every pull was dropped before the connection completed (~11 s, then "fetch failed").
 * Credentials do not lift an IP-range block, so the function now reads a keyless, publicly documented community
 * ADS-B API instead:  https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}   (no key; data licence ODbL 1.0)
 *   Data-licence credit: "Contains information from adsb.lol, made available under the ODbL 1.0."
 *
 * Allowlisted upstream only (fixed host + fixed regional points; no caller-supplied URLs or coordinates).
 * Six fixed regions in parallel under one 8 s deadline · ≤30 airborne aircraft per region (≤180) · 30 s in-memory
 * cache · 15 s shared cache · same-origin CORS.
 * r2 validation (nothing unproven is ever served as fresh):
 *   · upstream must answer exactly HTTP 200 with JSON {now, ac[]}
 *   · source time `now` must exist and be ≤ 60 s old and not in the future (our clock)
 *   · every row needs numeric in-range lat/lon and a position age 0…60 s; malformed rows are skipped, and a region
 *     whose rows are mostly malformed is a failed region
 *   · zero valid aircraft across all regions is a failure (six busy regions never legitimately read zero)
 *   A failed pull never replaces the last good set: a warm instance serves it with stale:true + reason.
 * r2 pacing: one hold deadline shared by every caller. Upstream 429 → hold for its Retry-After (120…3600 s);
 *   other failures → 120 s. While held there are zero upstream calls and every reply carries the remaining wait.
 */
export const config = { path: "/api/air" };

const HOST = "api.adsb.lol";
const REGIONS = [ // [label, lat, lon, radius_nm] — Texas first
  ["TX", 31.0, -98.6, 250],
  ["US-E", 40.7, -74.0, 250],
  ["US-W", 34.0, -118.2, 250],
  ["EU", 51.5, -0.1, 250],
  ["ME", 25.25, 55.36, 250],
  ["ASIA", 35.6, 139.8, 250],
];
const PER_REGION = 30;
const CACHE_MS = 30000;
const DEADLINE_MS = 8000;
const MAX_BYTES = 4 * 1024 * 1024;
const UA = "NEXUS-EYE/0.4.7 (+https://nexus-eye-doublea.netlify.app/)";
const FT = 0.3048, KT = 0.514444;

const SRC_MAX_AGE_S = 60, SRC_MAX_FUTURE_S = 0, POS_MAX_AGE_S = 60;
const HOLD_MIN_S = 120, HOLD_MAX_S = 3600;

let cache = { at: 0, payload: null };
let holdUntil = 0, holdReason = "";

/* Retry-After as delta-seconds or an HTTP date → seconds (0 if absent/unreadable) */
function retryAfterS(v, now) {
  if (v == null || v === "") return 0;
  if (/^\s*\d+\s*$/.test(String(v))) return +v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : 0;
}
function corsHeaders(req) {
  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin") || "";
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=10, s-maxage=15",
    "X-Nexus-Eye": "air-v0.4.7",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Retry-After",
  };
  if (!origin) {
    if (host) h["Access-Control-Allow-Origin"] = `https://${host}`;
  } else {
    try {
      const o = new URL(origin);
      if (o.host === host) { h["Access-Control-Allow-Origin"] = origin; h["Vary"] = "Origin"; }
      else h["X-Nexus-CORS"] = "cross-origin-denied";
    } catch { h["X-Nexus-CORS"] = "bad-origin"; }
  }
  return h;
}
const json = (status, body, headers, extra) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, ...(extra || {}) } });

/* source JSON {now, ac[]} → the trimmed shape the page draws (metres, m/s, degrees). Throws on an unprovable region. */
function trimRegion(j, label, nowS) {
  if (!j || typeof j !== "object" || !Array.isArray(j.ac)) throw new Error("bad shape");
  const rawNow = typeof j.now === "number" && Number.isFinite(j.now) ? j.now : NaN;
  if (!Number.isFinite(rawNow)) throw new Error("no source time");
  const tNow = rawNow > 1e12 ? rawNow / 1000 : rawNow;
  if (nowS - tNow > SRC_MAX_AGE_S) throw new Error("source time " + Math.round(nowS - tNow) + "s old");
  if (tNow - nowS > SRC_MAX_FUTURE_S) throw new Error("source time in the future");
  const out = [];
  let bad = 0;
  for (const a of j.ac) {
    if (!a || typeof a !== "object") { bad++; continue; }
    const lat = a.lat, lon = a.lon;
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) { bad++; continue; }
    const seenPos = typeof a.seen_pos === "number" ? a.seen_pos : typeof a.seen === "number" ? a.seen : NaN;
    if (!Number.isFinite(seenPos) || seenPos < 0) { bad++; continue; }   // missing or negative position age: unprovable
    if (a.alt_baro === "ground") continue;                               // airborne only (well-formed, just not drawn)
    if (seenPos > POS_MAX_AGE_S) continue;                               // position older than 60 s is not "live"
    if (out.length >= PER_REGION) continue;
    const altFt = typeof a.alt_baro === "number" ? a.alt_baro : typeof a.alt_geom === "number" ? a.alt_geom : null;
    const hex = typeof a.hex === "string" ? a.hex.replace(/[^0-9a-f~]/gi, "").slice(0, 8) : null;
    const call = typeof a.flight === "string" ? a.flight.replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 10) : "";
    out.push({
      icao: hex || null,
      callsign: call || null,
      lat: +lat.toFixed(4),
      lon: +lon.toFixed(4),
      alt: altFt != null && Number.isFinite(altFt) ? Math.round(altFt * FT) : null,
      velocity: typeof a.gs === "number" && Number.isFinite(a.gs) ? +(a.gs * KT).toFixed(1) : null,
      heading: typeof a.track === "number" && Number.isFinite(a.track) ? +a.track.toFixed(1) : typeof a.true_heading === "number" && Number.isFinite(a.true_heading) ? +a.true_heading.toFixed(1) : null,
      ts: Math.round(tNow - seenPos),
      region: label,
    });
  }
  if (j.ac.length && bad * 2 > j.ac.length) throw new Error("malformed rows " + bad + "/" + j.ac.length);
  return { rows: out, srcS: tNow };
}

async function fetchRegion([label, lat, lon, r], signal, fetchImpl) {
  const url = `https://${HOST}/v2/point/${lat}/${lon}/${r}`;
  if (new URL(url).host !== HOST) throw new Error("host");
  const res = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": UA }, signal, redirect: "error" });
  if (res.status === 429) { const e = new Error("rate-limited"); e.ra = retryAfterS(res.headers.get("retry-after"), Date.now()); e.rl = true; throw e; }
  if (res.status !== 200) throw new Error("http " + res.status);
  const cl = +res.headers.get("content-length") || 0;
  if (cl > MAX_BYTES) throw new Error("too-big");
  const txt = await res.text();
  if (txt.length > MAX_BYTES) throw new Error("too-big");
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error("bad json"); }
  return trimRegion(j, label, Date.now() / 1000);
}

async function pull(fetchImpl = globalThis.fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEADLINE_MS);
  try {
    const rs = await Promise.allSettled(REGIONS.map((g) => fetchRegion(g, ctl.signal, fetchImpl)));
    const aircraft = [], failed = [];
    let ra = 0, rl = false, srcS = Infinity;
    rs.forEach((r, i) => {
      if (r.status === "fulfilled") { aircraft.push(...r.value.rows); srcS = Math.min(srcS, r.value.srcS); }
      else {
        failed.push(REGIONS[i][0] + ":" + (r.reason && r.reason.name === "AbortError" ? "timeout" : String(r.reason && r.reason.message || r.reason).slice(0, 40)));
        if (r.reason && r.reason.rl) { rl = true; ra = Math.max(ra, r.reason.ra || 0); }
      }
    });
    return { aircraft, failed, ok: REGIONS.length - failed.length, ra, rl, srcS };
  } finally { clearTimeout(timer); }
}

export default async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return json(405, { ok: false, error: "method" }, headers);
  const host = req.headers.get("host") || "", origin = req.headers.get("origin") || "";
  if (origin && host) {
    try { if (new URL(origin).host !== host) return json(403, { ok: false, error: "cors", message: "same-origin only" }, headers); }
    catch { return json(403, { ok: false, error: "cors" }, headers); }
  }
  const kill = String(process.env.AIR_DISABLED || "").toLowerCase();
  if (kill === "1" || kill === "true")
    return json(503, { ok: false, error: "disabled", reason: "AIR feed switched off by the site operator" }, headers, { "Retry-After": "600", "Cache-Control": "no-store" });

  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_MS)
    return json(200, { ...cache.payload, cached: true, age_ms: now - cache.at }, headers,
      now < holdUntil ? { "Retry-After": String(Math.ceil((holdUntil - now) / 1000)) } : null);
  if (now < holdUntil) return held(now, headers);

  let r;
  try { r = await pull(); } catch (e) { r = { aircraft: [], failed: ["all:" + String(e && e.message || e).slice(0, 40)], ok: 0, ra: 0, rl: false, srcS: Infinity }; }
  // a rate-limit from any region pauses every caller for the source's requested wait (bounded), even on partial success
  if (r.rl) { holdUntil = now + Math.min(HOLD_MAX_S, Math.max(HOLD_MIN_S, r.ra || 0)) * 1000; holdReason = "community ADS-B feed asked us to slow down (rate-limited)"; }
  if (r.ok > 0 && r.aircraft.length > 0 && Number.isFinite(r.srcS)) {
    const payload = {
      ok: true, source: "adsb.lol", license: "ODbL-1.0",
      time: Math.floor(r.srcS),           // oldest source time among the regions used (s) — the client's freshness anchor
      pulledAt: Math.floor(now / 1000),
      count: r.aircraft.length, aircraft: r.aircraft,
      regionsOk: r.ok, regionsTotal: REGIONS.length, partial: r.ok < REGIONS.length,
      failedRegions: r.failed, cached: false,
    };
    cache = { at: now, payload };
    if (!r.rl) { holdUntil = 0; holdReason = ""; }
    return json(200, payload, headers, r.rl ? { "Retry-After": String(Math.ceil((holdUntil - now) / 1000)) } : null);
  }
  const why = r.ok > 0 ? "no valid aircraft in the source reply" : r.failed.slice(0, 3).join(", ");
  if (!r.rl) { holdUntil = now + HOLD_MIN_S * 1000; holdReason = "community ADS-B feed unavailable from the server: " + why; }
  else holdReason += " · " + why;
  return held(now, headers);
};

/* reply while held: last good set (stale:true) if this instance has one, else 503 — always with the remaining wait */
function held(now, headers) {
  const left = Math.max(1, Math.ceil((holdUntil - now) / 1000));
  const extra = { "Retry-After": String(left), "Cache-Control": "no-store" };
  if (cache.payload) return json(200, { ...cache.payload, cached: true, stale: true, reason: holdReason, retryAfter: left, age_ms: now - cache.at }, headers, extra);
  return json(503, { ok: false, error: "upstream", reason: holdReason, retryAfter: left }, headers, extra);
}
