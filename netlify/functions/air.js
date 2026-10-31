/**
 * NEXUS EYE v0.3 — AIR LIVE proxy (modern Netlify Function)
 * Allowlisted OpenSky Network states/all only.
 * Server-side fetch · trimmed aircraft · ~20s cache · same-origin CORS.
 */
export const config = { path: "/api/air" };

const OPENSKY = "https://opensky-network.org/api/states/all";
const CACHE_MS = 20000;
const MAX_AC = 180;

let cache = { at: 0, payload: null };

function corsHeaders(req) {
  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin") || "";
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=10, s-maxage=20",
    "X-Nexus-Eye": "air-v0.3",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

function trimStates(data) {
  const now = Date.now();
  const states = Array.isArray(data?.states) ? data.states : [];
  const time = data?.time || Math.floor(now / 1000);
  const aircraft = [];
  for (let i = 0; i < states.length && aircraft.length < MAX_AC; i++) {
    const s = states[i];
    if (!s || s.length < 11) continue;
    const lon = s[5];
    const lat = s[6];
    if (lat == null || lon == null || !Number.isFinite(+lat) || !Number.isFinite(+lon)) continue;
    if (Math.abs(+lat) > 90 || Math.abs(+lon) > 180) continue;
    const call = (s[1] && String(s[1]).trim()) || null;
    aircraft.push({
      icao: s[0] || null,
      callsign: call,
      lat: +lat,
      lon: +lon,
      alt: s[7] != null ? +s[7] : s[13] != null ? +s[13] : null,
      velocity: s[9] != null ? +s[9] : null,
      heading: s[10] != null ? +s[10] : null,
      ts: s[4] != null ? +s[4] : time,
    });
  }
  return { ok: true, source: "opensky", time, count: aircraft.length, aircraft, cached: false };
}

export default async (req) => {
  const headers = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "GET") {
    return json(405, { ok: false, error: "method" }, headers);
  }

  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin") || "";
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return json(403, { ok: false, error: "cors", message: "same-origin only" }, headers);
      }
    } catch {
      return json(403, { ok: false, error: "cors" }, headers);
    }
  }

  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_MS) {
    return json(200, { ...cache.payload, cached: true, age_ms: now - cache.at }, headers);
  }

  try {
    const ctrl =
      typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(12000)
        : undefined;
    const res = await fetch(OPENSKY, {
      headers: {
        Accept: "application/json",
        "User-Agent": "NEXUS-EYE/0.3 (DoubleA; public-demo)",
      },
      signal: ctrl,
    });
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
          headers
        );
      }
      return json(502, { ok: false, error: "upstream", status: res.status }, headers);
    }
    const data = await res.json();
    const payload = trimStates(data);
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
        headers
      );
    }
    return json(
      503,
      { ok: false, error: "fetch", message: String(err?.message || err) },
      headers
    );
  }
};
