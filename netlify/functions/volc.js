/**
 * NEXUS EYE v0.4.8 — VOLC proxy (server function) · original NEXUS architecture
 * LIVE part: USGS Volcano Hazards Program HANS public API (keyless):
 *   getElevatedVolcanoes  → current elevated US volcanoes (alert level + aviation color code)
 *   getMonitoredVolcanoes → every monitored US volcano with its latest level/color (mostly NORMAL/GREEN)
 *   getUSVolcanoes        → coordinates by vnum (getCapElevated is the fallback for elevated coords)
 * CATALOG part (static context, never labelled LIVE): Smithsonian GVP Holocene volcano list (public WFS GeoJSON),
 *   thinned server-side to [lat, lon, name, country, lastEruptionYear, vnum] and cached 24 h.
 * Server-side fetch · ~15 min cache · same-origin CORS like fire.js.
 * Never invents points: HANS failure → 502 {ok:false} (or last-good cache if warm). A volcano without
 * published coordinates is listed but not drawn.
 */
export const config = { path: "/api/volc" };

const HANS = "https://volcanoes.usgs.gov/hans-public/api/volcano/";
const GVP =
  "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=1.0.0&request=GetFeature" +
  "&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&outputFormat=application/json" +
  "&propertyName=Volcano_Number,Volcano_Name,Last_Eruption_Year,Country,GeoLocation";
const CACHE_MS = 15 * 60 * 1000;
const META_MS = 24 * 60 * 60 * 1000;
const UA = "NEXUS-EYE/0.4.8 (DoubleA; public-demo)";
const LEVELS = ["NORMAL", "ADVISORY", "WATCH", "WARNING"];
const COLORS = ["GREEN", "YELLOW", "ORANGE", "RED"];

let cache = { at: 0, payload: null };
let coords = { at: 0, map: null };
let catalog = { at: 0, pts: null, err: "" };

function corsHeaders(req) {
  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin") || "";
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60, s-maxage=900",
    "X-Nexus-Eye": "volc-v0.4.8",
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

async function getJson(url, ms, deadline) {
  const signal =
    typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(Math.max(1, Math.min(ms || 12000, deadline ? deadline-Date.now() : 12000))) : undefined;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA }, signal });
  if (!res.ok) {
    const e = new Error("HTTP " + res.status);
    e.status = res.status;
    e.retryAfter = res.headers.get("Retry-After");
    throw e;
  }
  return res.json();
}

const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 120);
const up = (v) => str(v, 16).toUpperCase();
const num = (v) => ((typeof v === "number" || typeof v === "string" && v.trim() !== "") && Number.isFinite(Number(v)) ? Number(v) : NaN);
function okCoord(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
function sentIso(utc) {
  /* HANS sent_utc is "YYYY-MM-DD HH:MM:SS" in UTC */
  const s = str(utc, 32);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return "";
  return s.replace(" ", "T") + "Z";
}
function safeUrl(u) {
  const s = str(u, 300);
  return /^https:\/\/volcanoes\.usgs\.gov\//.test(s) ? s : "";
}
function rank(level, color) {
  return Math.max(LEVELS.indexOf(up(level)), COLORS.indexOf(up(color)), 0);
}

async function loadCoords(now, deadline) {
  if (coords.map && now - coords.at < META_MS) return coords.map;
  try {
    const us = await getJson(HANS + "getUSVolcanoes", 12000, deadline);
    if (!Array.isArray(us)) throw new Error("bad getUSVolcanoes");
    const map = {};
    for (const u of us) {
      const lat = num(u && u.latitude),
        lon = num(u && u.longitude);
      if (u && u.vnum && okCoord(lat, lon))
        map[str(u.vnum, 12)] = { lat: +lat.toFixed(4), lon: +lon.toFixed(4), region: str(u.region, 60) };
    }
    coords = { at: now, map };
  } catch (e) {
    if (!coords.map) coords = { at: 0, map: {} };
  }
  return coords.map;
}

async function loadCatalog(now, deadline) {
  if (catalog.pts && now - catalog.at < META_MS) return catalog;
  try {
    const j = await getJson(GVP, 12000, deadline);
    const f = j && Array.isArray(j.features) ? j.features : null;
    if (!f) throw new Error("bad GVP payload");
    const pts = [];
    for (const x of f) {
      const c = x && x.geometry && x.geometry.coordinates;
      if (!Array.isArray(c)) continue;
      const lon = num(c[0]),
        lat = num(c[1]);
      if (!okCoord(lat, lon)) continue;
      const p = x.properties || {};
      const ly = Number.isFinite(num(p.Last_Eruption_Year)) ? Math.trunc(num(p.Last_Eruption_Year)) : null;
      pts.push([+lat.toFixed(3), +lon.toFixed(3), str(p.Volcano_Name, 60), str(p.Country, 40), ly, str(p.Volcano_Number, 8)]);
    }
    if (!pts.length) throw new Error("GVP returned 0 volcanoes");
    catalog = { at: now, pts, err: "" };
  } catch (e) {
    catalog.err = String((e && e.message) || e);
    if (!catalog.pts) catalog.at = 0;
  }
  return catalog;
}

function validateRows(rows, monitored) {
  if (!Array.isArray(rows)) throw new Error(monitored ? "monitored coverage unavailable: malformed required feed" : "malformed required elevated feed");
  for (const v of rows) {
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.volcano_name !== "string" || !v.volcano_name.trim() ||
        typeof v.alert_level !== "string" || !LEVELS.includes(v.alert_level) || typeof v.color_code !== "string" || !COLORS.includes(v.color_code))
      throw new Error("malformed required volcano row or alert state");
    /* HANS includes explicitly identified regional summaries, not individual volcanoes. */
    const regional = monitored && v.vnum === null && typeof v.volcano_cd === "string" && v.volcano_cd.trim() && typeof v.obs_abbr === "string" && v.obs_abbr.trim();
    if (!regional && !((typeof v.vnum === "string" && v.vnum.trim()) || (typeof v.vnum === "number" && Number.isFinite(v.vnum))))
      throw new Error("malformed required volcano identity");
    for (const k of ["obs_abbr", "obs_fullname", "sent_utc", "notice_url"]) if (v[k] != null && typeof v[k] !== "string") throw new Error("malformed volcano " + k);
  }
}
async function build(now) {
  /* One parallel 12-second budget, safely below the client's 18-second abort.
     Both official collections are required for a complete LIVE coverage claim. */
  const deadline = now + 12000;
  const [elevatedRaw, monRaw, map, cat, capRaw] = await Promise.all([
    getJson(HANS + "getElevatedVolcanoes", 12000, deadline).then(v => { validateRows(v, false); return v; }),
    getJson(HANS + "getMonitoredVolcanoes", 12000, deadline).then(v => { validateRows(v, true); return v; }).catch(e => {
      if (!/^monitored coverage unavailable/.test(e.message)) e.message = "monitored coverage unavailable: " + e.message; throw e;
    }),
    loadCoords(now, deadline),
    loadCatalog(now, deadline),
    getJson(HANS + "getCapElevated", 12000, deadline).catch(() => null),
  ]);
  const capMap = {};
  if (Array.isArray(capRaw))
    for (const c of capRaw) {
      const lat = num(c && c.latitude),
        lon = num(c && c.longitude);
      if (c && c.vnum && okCoord(lat, lon)) capMap[str(c.vnum, 12)] = { lat: +lat.toFixed(4), lon: +lon.toFixed(4), synopsis: str(c.synopsis, 280) };
    }
  const row = (v, elevated) => {
    const vnum = str(v.vnum, 12);
    const at = map[vnum] || capMap[vnum] || null;
    const level = up(v.alert_level),
      color = up(v.color_code);
    return {
      vnum,
      name: str(v.volcano_name, 60),
      obs: str(v.obs_abbr, 8).toUpperCase(),
      obsName: str(v.obs_fullname, 80),
      level: LEVELS.includes(level) ? level : "",
      color: COLORS.includes(color) ? color : "",
      rank: rank(level, color),
      sent: sentIso(v.sent_utc),
      url: safeUrl(v.notice_url),
      lat: at ? at.lat : null,
      lon: at ? at.lon : null,
      synopsis: elevated && capMap[vnum] ? capMap[vnum].synopsis : "",
      elevated: !!elevated,
    };
  };
  const byV = {};
  if (Array.isArray(monRaw))
    for (const m of monRaw) {
      if (!m || !m.vnum) continue;
      const r = row(m, false);
      /* Legitimate coordinate-less volcanoes remain listed, never drawn. */
      byV[r.vnum] = r;
    }
  const elevated = [];
  for (const e of elevatedRaw) {
    if (!e || !e.vnum) continue;
    const r = row(e, true);
    elevated.push(r);
    byV[r.vnum] = r; /* elevated notice is the freshest state for that volcano */
  }
  for (const k in byV) if (byV[k].rank > 0 && !byV[k].elevated) byV[k].elevated = true;
  const volcanoes = Object.values(byV).sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  elevated.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  const counts = { NORMAL: 0, ADVISORY: 0, WATCH: 0, WARNING: 0, UNASSIGNED: 0 };
  for (const v of volcanoes) counts[v.level || "UNASSIGNED"]++;
  return {
    ok: true,
    source: "usgs-hans",
    sourceName: "USGS Volcano Hazards Program · HANS public API",
    pulledAt: new Date(now).toISOString(),
    monitoredOk: Array.isArray(monRaw),
    counts,
    elevatedCount: elevated.length,
    count: volcanoes.length,
    elevated,
    volcanoes,
    catalog: {
      ok: !!(cat.pts && cat.pts.length),
      source: "smithsonian-gvp-holocene",
      label: "CATALOG",
      pulledAt: cat.at ? new Date(cat.at).toISOString() : null,
      count: cat.pts ? cat.pts.length : 0,
      fields: ["lat", "lon", "name", "country", "lastEruptionYear", "vnum"],
      pts: cat.pts || [],
      err: cat.err || "",
    },
    cached: false,
  };
}

export default async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return json(405, { ok: false, error: "method" }, headers);

  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin") || "";
  if (origin && host) {
    try {
      if (new URL(origin).host !== host)
        return json(403, { ok: false, error: "cors", message: "same-origin only" }, headers);
    } catch {
      return json(403, { ok: false, error: "cors" }, headers);
    }
  }

  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_MS) {
    return json(200, { ...cache.payload, cached: true, age_ms: now - cache.at }, headers);
  }
  try {
    const payload = await build(now);
    cache = { at: now, payload };
    return json(200, payload, headers);
  } catch (err) {
    if (err && err.status === 429) {
      headers["Retry-After"] = err.retryAfter || "3600";
      headers["Cache-Control"] = "no-store";
      headers["Access-Control-Expose-Headers"] = "Retry-After";
      return json(429, { ok: false, error: "rate-limited", message: err.message }, headers);
    }
    if (cache.payload) {
      return json(
        200,
        { ...cache.payload, cached: true, stale: true, error: String((err && err.message) || err), coverageError: /monitored coverage/.test(String(err && err.message)) ? String(err.message) : "", age_ms: now - cache.at },
        headers
      );
    }
    return json(
      502,
      { ok: false, error: "upstream", status: (err && err.status) || null, message: String((err && err.message) || err) },
      headers
    );
  }
};
