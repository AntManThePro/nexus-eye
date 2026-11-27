/**
 * NEXUS EYE v0.4.7 — FIRE LIVE proxy (server function)
 * NASA FIRMS MODIS C6.1 Global 24h CSV (keyless public feed).
 * Server-side fetch · thinned hotspots · ~12 min cache · same-origin CORS.
 * Never invents points: upstream failure → 502 {ok:false} (or last-good cache if warm).
 */
export const config = { path: "/api/fire" };

const FIRMS =
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv";
const CACHE_MS = 12 * 60 * 1000;
const MAX_PTS = 800;
const PREF_CONF = 70;
const PREF_FRP = 15;

let cache = { at: 0, payload: null };

function corsHeaders(req) {
  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin") || "";
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60, s-maxage=720",
    "X-Nexus-Eye": "fire-v0.4.7",
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

function parseConf(v) {
  if (v == null || v === "") return 0;
  const n = +v;
  if (Number.isFinite(n)) return n;
  const s = String(v).toLowerCase();
  if (s === "h" || s === "high") return 90;
  if (s === "n" || s === "nominal") return 50;
  if (s === "l" || s === "low") return 20;
  return 0;
}

function parseCsv(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length < 2) return [];
  const hdr = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const ix = (name) => hdr.indexOf(name);
  const iLat = ix("latitude"),
    iLon = ix("longitude"),
    iFrp = ix("frp"),
    iSat = ix("satellite"),
    iDn = ix("daynight"),
    iDate = ix("acq_date"),
    iTime = ix("acq_time"),
    iConf = ix("confidence");
  if (iLat < 0 || iLon < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(",");
    const lat = +c[iLat],
      lon = +c[iLon];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const frp = iFrp >= 0 && c[iFrp] !== "" ? +c[iFrp] : 0;
    const conf = iConf >= 0 ? parseConf(c[iConf]) : 0;
    out.push({
      lat: +lat.toFixed(4),
      lon: +lon.toFixed(4),
      frp: Number.isFinite(frp) ? +(+frp).toFixed(2) : 0,
      sat: iSat >= 0 ? String(c[iSat] || "").trim().slice(0, 4) : "",
      dn: iDn >= 0 ? String(c[iDn] || "").trim().slice(0, 1) : "",
      date: iDate >= 0 ? String(c[iDate] || "").trim() : "",
      time: iTime >= 0 ? String(c[iTime] || "").trim().padStart(4, "0").slice(0, 4) : "",
      conf: String(conf),
      _conf: conf,
      _frp: Number.isFinite(frp) ? frp : 0,
    });
  }
  return out;
}

function thin(rows) {
  const pref = rows.filter((r) => r._conf >= PREF_CONF || r._frp >= PREF_FRP);
  const pool = pref.length ? pref : rows.slice();
  pool.sort((a, b) => b._frp - a._frp || b._conf - a._conf);
  const take = pool.slice(0, MAX_PTS);
  return take.map(({ lat, lon, frp, sat, dn, date, time, conf }) => ({
    lat,
    lon,
    frp,
    sat,
    dn,
    date,
    time,
    conf,
  }));
}

export default async (req) => {
  const headers = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "GET") {
    return json(405, { ok: false, error: "method" }, {...headers,"Cache-Control":"no-store"});
  }

  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin") || "";
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return json(403, { ok: false, error: "cors", message: "same-origin only" }, {...headers,"Cache-Control":"no-store"});
      }
    } catch {
      return json(403, { ok: false, error: "cors" }, {...headers,"Cache-Control":"no-store"});
    }
  }

  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_MS) {
    return json(200, { ...cache.payload, cached: true, age_ms: now - cache.at }, {...headers,"Cache-Control":"no-store"});
  }

  try {
    const ctrl =
      typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(20000)
        : undefined;
    const res = await fetch(FIRMS, {
      headers: {
        Accept: "text/csv,*/*",
        "User-Agent": "NEXUS-EYE/0.4.7 (DoubleA; public-demo)",
      },
      signal: ctrl,
    });
    if (res.status === 429) {
      const raw = res.headers.get("retry-after");
      const seconds = /^\s*\d+\s*$/.test(raw || "") ? +raw : Math.ceil((Date.parse(raw) - now) / 1000);
      return json(429, {ok:false,error:"rate-limited"}, {...headers,"Retry-After":String(Number.isFinite(seconds) && seconds > 0 ? seconds : 3600),"Cache-Control":"no-store"});
    }
    if (!res.ok) {
      if (cache.payload) {
        return json(
          200,
          {
            ...cache.payload,
            cached: true,
            stale: true,
            upstream: res.status,
            age_ms: now - cache.at,
          },
          {...headers,"Cache-Control":"no-store"}
        );
      }
      return json(502, { ok: false, error: "upstream", status: res.status }, {...headers,"Cache-Control":"no-store"});
    }
    const text = await res.text();
    const fires = thin(parseCsv(text));
    const payload = {
      ok: true,
      source: "firms-modis-c6.1",
      window: "24h",
      count: fires.length,
      pulledAt: new Date(now).toISOString(),
      fires,
      cached: false,
    };
    cache = { at: now, payload };
    return json(200, payload, headers);
  } catch (err) {
    if (cache.payload) {
      return json(
        200,
        {
          ...cache.payload,
          cached: true,
          stale: true,
          error: String(err?.message || err),
          age_ms: now - cache.at,
        },
        {...headers,"Cache-Control":"no-store"}
      );
    }
    return json(
      502,
      { ok: false, error: "fetch", message: String(err?.message || err) },
      {...headers,"Cache-Control":"no-store"}
    );
  }
};
