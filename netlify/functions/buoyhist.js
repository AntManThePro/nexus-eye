/**
 * NEXUS EYE v0.4.11 — BUOY TREND proxy (server function) · original NEXUS architecture
 * One station's recent measured history from the NOAA NDBC "realtime2" standard meteorological file
 * (keyless, public): https://www.ndbc.noaa.gov/data/realtime2/{STATION}.txt
 * NDBC sends no CORS header, so this function fetches server-side, keeps the last 48 h,
 * thins each series to its newest reading per hour, and returns compact JSON. Only called when a buoy card opens.
 * Never invents a value: "MM" stays null; out-of-range values and sentinels are dropped, never clamped.
 * Station id is validated (3–8 alphanumerics) and only ever used to build the fixed NDBC URL — not an open proxy.
 * v0.4.8.1:
 *  - strict time bounds (month 1–12, day 1–31 with round-trip check, hour 0–23, minute 0–59, no future rows) — never rolled over
 *  - upstream 429 / 503 pass Retry-After on and hold server-side; every error is cached so repeat opens don't reach NDBC
 *  - response size cap (2 MB, Content-Length check + streamed byte count) — over the cap is an error, never a 200
 *  - redirect:'error' (the fixed NDBC URL must answer directly)
 *  - error bodies carry a short code + friendly text, never raw upstream or exception text
 * v0.4.8.2: held errors also carry what NDBC asked for (upstreamRetryAfter) and capped:true when the hold is shorter
 *   (429 holds at most 6 h, 5xx at most 1 h), so the card can say so honestly.
 */
export const config = { path: "/api/buoyhist" };

const BASE = "https://www.ndbc.noaa.gov/data/realtime2/";
const CACHE_MS = 15 * 60 * 1000;          /* fresh 200 kept in memory */
const NONE_MS = 60 * 60 * 1000;           /* NDBC 404 (no history file) */
const WINDOW_MS = 48 * 3600 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;        /* real files are ~0.6 MB */
const HOLD_429_MIN = 900, HOLD_MAX = 6 * 3600;
const HOLD_5XX_DEFAULT = 300, HOLD_5XX_MIN = 60, HOLD_5XX_MAX = 3600;
const HOLD_FETCH = 120, HOLD_BAD = 900;
const UA = "NEXUS-EYE/0.4.11 (DoubleA; public-demo)";
/* column, key, min, max, sentinels — anything outside the range or equal to a sentinel is dropped */
const KEEP = [["WVHT", "wvht", 0, 30, [99]], ["WSPD", "wspd", 0, 75, [99]], ["PRES", "pres", 850, 1090, [9999]], ["WTMP", "wtmp", -5, 40, [99, 999]]];
const FRIENDLY = {
  "rate-limited": "NDBC is rate-limiting requests",
  upstream: "NDBC is not answering right now",
  timeout: "NDBC took too long to answer",
  fetch: "could not reach NDBC",
  oversize: "NDBC file larger than expected",
  malformed: "NDBC file could not be read",
  "no-history": "NDBC publishes no realtime history file for this station",
};
const cache = new Map();                  /* id → { at, until, status, body, retry } */
let hold429 = { until: 0, asked: 0, capped: false, secs: 0 };   /* NDBC rate limit applies to the host, so it holds every station */

function corsHeaders(req) {
  const host = req.headers.get("host") || "", origin = req.headers.get("origin") || "";
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=300",
    "X-Nexus-Eye": "buoyhist-v0.4.11", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Retry-After" };
  if (origin) { try { if (new URL(origin).host === host) { h["Access-Control-Allow-Origin"] = origin; h["Vary"] = "Origin"; } } catch {} }
  return h;
}
const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers });
function num(tok) { const s = String(tok == null ? "" : tok).trim(); if (!s || s === "MM" || !/^[-+]?\d+(\.\d+)?$/.test(s)) return null; const n = Number(s); return Number.isFinite(n) ? n : null; }

export function retryAfterSeconds(raw, now, dflt) {
  const s = String(raw || "").trim();
  if (!s) return dflt;
  const n = /^\d+$/.test(s) ? +s : Math.ceil((Date.parse(s) - now) / 1000);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/* strict UTC time from the 5 leading columns; null when any part is out of bounds or does not round-trip */
export function strictTime(Y, Mo, D, H, Mi) {
  if (![Y, Mo, D, H, Mi].every((v) => v != null && Number.isInteger(v))) return null;
  if (Y < 1970 || Y > 9999 || Mo < 1 || Mo > 12 || D < 1 || D > 31 || H < 0 || H > 23 || Mi < 0 || Mi > 59) return null;
  const t = Date.UTC(Y, Mo - 1, D, H, Mi);
  if (!Number.isFinite(t)) return null;
  const b = new Date(t);
  if (b.getUTCFullYear() !== Y || b.getUTCMonth() !== Mo - 1 || b.getUTCDate() !== D || b.getUTCHours() !== H || b.getUTCMinutes() !== Mi) return null;
  return t;
}

export function parseRealtime2(text, now, statsOut) {
  const lines = String(text || "").split(/\r?\n/);
  const hdrLine = lines.find((l) => /^#\s*(YY|YYYY)\s+MM\s+DD\s+hh\s+mm\b/.test(l));
  if (!hdrLine) throw new Error("malformed");
  const hdr = hdrLine.replace(/^#\s*/, "").trim().split(/\s+/);
  const ix = KEEP.map(([col, key, lo, hi, sent]) => [hdr.indexOf(col), key, lo, hi, sent]);
  const stats = statsOut || {}; Object.assign(stats, { rows: 0, badRow: 0, badTime: 0, future: 0, old: 0, dropped: 0 });
  /* per series: newest valid reading in each UTC hour, each with its OWN observation time (no cross-row merging) */
  const series = {}; for (const [, key] of ix) series[key] = new Map();
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;
    stats.rows++;
    const c = line.trim().split(/\s+/);
    if (c.length !== hdr.length) { stats.badRow++; continue; }
    const t = strictTime(...c.slice(0, 5).map(num));
    if (t == null) { stats.badTime++; continue; }
    if (t > now) { stats.future++; continue; }
    if (now - t > WINDOW_MS) { stats.old++; continue; }
    const hk = Math.floor(t / 3600000);
    for (const [i, key, lo, hi, sent] of ix) {
      if (i < 0) continue; const v = num(c[i]);
      if (v == null) continue;
      if (v < lo || v > hi || sent.includes(v)) { stats.dropped++; continue; }
      const prev = series[key].get(hk);
      if (!prev || t > prev[0]) series[key].set(hk, [t, v]);
    }
  }
  const out = {};
  for (const [, key] of ix) out[key] = [...series[key].values()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [new Date(t).toISOString(), v]);
  return out;
}

/* read at most MAX_BYTES; anything bigger fails closed */
async function readCapped(res) {
  const cl = Number(res.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > MAX_BYTES) { try { await res.body?.cancel(); } catch {} throw new Error("oversize"); }
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error("oversize");
    return new TextDecoder().decode(buf);
  }
  const reader = res.body.getReader(), parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BYTES) { try { await reader.cancel(); } catch {} throw new Error("oversize"); }
    parts.push(value);
  }
  const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

const errBody = (id, code, status, retry, asked, capped, hold) => ({ ok: false, id, error: code, ...(status ? { status } : {}), ...(retry ? { retryAfter: retry } : {}),
  ...(asked ? { upstreamRetryAfter: asked } : {}), ...(capped ? { capped: true, cappedAt: hold || retry } : {}), message: FRIENDLY[code] || FRIENDLY.upstream });

export default async (req) => {
  const headers = corsHeaders(req), noStore = { ...headers, "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return json(405, { ok: false, error: "method" }, noStore);
  const host = req.headers.get("host") || "", origin = req.headers.get("origin") || "";
  if (origin && host) { try { if (new URL(origin).host !== host) return json(403, { ok: false, error: "cors" }, noStore); } catch { return json(403, { ok: false, error: "cors" }, noStore); } }
  const id = String(new URL(req.url).searchParams.get("id") || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(id)) return json(400, { ok: false, error: "bad-id" }, noStore);
  const now = Date.now();
  const withRetry = (until) => ({ ...noStore, "Retry-After": String(Math.max(1, Math.ceil((until - now) / 1000))) });

  /* 1. host-wide rate-limit hold */
  if (now < hold429.until) {
    const left = Math.max(1, Math.ceil((hold429.until - now) / 1000));
    return json(429, { ...errBody(id, "rate-limited", 429, left, hold429.asked, hold429.capped, hold429.secs), held: true }, withRetry(hold429.until));
  }
  /* 2. per-station cache: fresh 200, 404, or a held error */
  const hit = cache.get(id);
  if (hit && now >= hit.at && now < hit.until) {
    if (hit.status === 200) return json(200, { ...hit.body, cached: true, age_ms: now - hit.at }, headers);
    if (hit.status === 404) return json(404, { ...hit.body, cached: true }, noStore);
    const left = Math.max(1, Math.ceil((hit.until - now) / 1000));
    return json(hit.status, { ...hit.body, retryAfter: left, held: true }, withRetry(hit.until));
  }
  const remember = (status, body, ms) => {
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(id, { at: now, until: now + ms, status, body });
    if (status === 200) return json(200, body, headers);
    if (status === 404) return json(404, body, noStore);
    return json(status, body, withRetry(now + ms));
  };

  try {
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined;
    const res = await fetch(BASE + id + ".txt", { headers: { Accept: "text/plain,*/*", "User-Agent": UA }, redirect: "error", signal });
    if (res.status === 404) { try { await res.body?.cancel(); } catch {} return remember(404, errBody(id, "no-history"), NONE_MS); }
    if (res.status === 429) {
      try { await res.body?.cancel(); } catch {}
      const asked = retryAfterSeconds(res.headers.get("retry-after"), now, 0);
      const secs = Math.min(HOLD_MAX, Math.max(HOLD_429_MIN, asked || HOLD_429_MIN)), capped = asked > secs;
      hold429 = { until: now + secs * 1000, asked, capped, secs };
      return json(429, errBody(id, "rate-limited", 429, secs, asked, capped), withRetry(hold429.until));
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch {}
      const asked = retryAfterSeconds(res.headers.get("retry-after"), now, 0);
      const secs = Math.min(HOLD_5XX_MAX, Math.max(HOLD_5XX_MIN, asked || HOLD_5XX_DEFAULT)), capped = asked > secs;
      const status = res.status === 503 ? 503 : 502;
      return remember(status, errBody(id, "upstream", res.status, secs, asked, capped), secs * 1000);
    }
    const stats = {};
    const series = parseRealtime2(await readCapped(res), now, stats);
    const count = Object.values(series).reduce((n, a) => n + a.length, 0);
    return remember(200, { ok: true, id, source: "ndbc-realtime2", sourceUrl: BASE + id + ".txt", pulledAt: new Date(now).toISOString(),
      windowHours: 48, step: "newest reading per UTC hour, per series, each with its own time", units: { wvht: "m", wspd: "m/s", pres: "hPa", wtmp: "degC" },
      count, stats, series, cached: false }, CACHE_MS);
  } catch (err) {
    const m = String((err && err.message) || "");
    const code = err && err.name === "TimeoutError" ? "timeout" : m === "oversize" ? "oversize" : m === "malformed" ? "malformed" : "fetch";
    const secs = code === "oversize" || code === "malformed" ? HOLD_BAD : HOLD_FETCH;
    return remember(502, errBody(id, code, 0, secs), secs * 1000);
  }
};
