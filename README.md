# NEXUS EYE v0.4.1-launch

Field-ops planet console by DoubleA (@AntManThePro).
Original NEXUS architecture, built from scratch.

## Open
- Local: open `index.html` or `NEXUS-EYE.html` (AIR stays PROTO — no Function)
- Live: https://nexus-eye-doublea.netlify.app/
- Deep-link example: `?lat=37.77&lon=-122.42&alt=3.2&layers=quake,iss,sats`

## Layers
- QUAKE · LIVE (USGS) · STALE/OFFLINE honest fallback
- HAZ · LIVE (NASA EONET natural hazards)
- ALERTS · NWS — active alerts from api.weather.gov (no key). LIVE only when the last pull is < 10 min old
  AND the feed's own `updated` is < 10 min old (and not more than 5 min in the future); otherwise STALE with the real age.
  Only alerts still in effect (now < ends || expires) are listed, drawn or tappable. Not affiliated with or endorsed by
  NWS/NOAA — for official warnings use weather.gov and local authorities.
- LAUNCH · LL2 (new in v0.4.1) — upcoming orbital launches from The Space Devs Launch Library 2 (keyless, published schedule, not telemetry); pads clustered by site, tap for card with status/NET/window/weather; honest precision (no countdown for day/month/quarter NETs); hourly cache + backoff
- SATS · SGP4 (new in v0.4.0) — 198 satellites (space stations, brightest visible, GPS) from CelesTrak GP elements
  (keyless), positions computed in the browser with SGP4 (satellite.js 5.0.0, self-hosted in `lib/`, MIT).
  Badge reads `PROPAGATED <age>` — the age is the median TLE epoch age of the elements, not the download time;
  `STALE` when that median is > 72 h. Model positions, not radar-observed. Elements are cached 2 h; refresh failures
  back off 30 s → 60 s → 2 m → 5 m → 10 m (cap, jittered), one request at a time, last-good elements kept;
  CelesTrak's "GP data has not updated" answer is paced like a success (next try in 2 h). Auto-retries when the
  browser comes back online. Tap a satellite for its card (altitude, speed, inclination, period, NORAD id, TLE epoch
  in CT, CelesTrak link) and next-orbit track; Esc, × or an empty tap closes it.
  Orbital data: CelesTrak (celestrak.org), originating with NORAD / US Space Force (space-track.org). Not affiliated with
  or endorsed by CelesTrak, NORAD or the US Space Force.
- ISS · LIVE · WX · LIVE
- AIR · LIVE on CDN when `/api/air` (OpenSky allowlist Function) returns real data; honest PROTO fallback otherwise
- ORBIT · KEPLER
- CCTV · PUBLIC (+ last-good / FRAME OFFLINE) · TxDOT cams via `/api/cam` (allowlisted snapshot Function) + `cctv-pack.json`

## Tap priority
Inside an alert polygon the alert wins unless a point object (cam, satellite, quake/haz/wx/ISS/air marker) is within
~6 px of the tap (a cam counts there only if it is not part of a cluster). Outside polygons the nearest object within
6 px wins; otherwise a satellite only takes the tap when it is clearly closer (≥ 6 px nearer) than any cam or alert edge.

## Stack
Three.js r128 (CDN) · satellite.js 5.0.0 (self-hosted, `lib/`) · vanilla JS · single HTML · Netlify Functions · mobile + desktop

## Release
v0.4.1-launch — LAUNCH layer (LL2 schedule), pad card, paced hourly refresh/backoff/429 handling, STALE after 6h.
v0.4.0-sats — SATS layer (CelesTrak GP + SGP4), satellite card, paced refresh/backoff, tap priority rule, 11 px badges.
v0.3.9-nws — NWS active-alerts layer (polygons, list, detail card, TX filter), touch tap tolerance, expiry/freshness rules.
v0.3.8.1-icon — home-screen icon + PWA manifest. v0.3.8-cctv — CCTV pack. v0.3.7 — HAZ layer, QUAKE honesty fix.
