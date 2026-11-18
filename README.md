# NEXUS EYE v0.4.5

Field-ops planet console by DoubleA (@AntManThePro). A photoreal globe with live public intel — quakes, weather alerts, launches, satellites, aurora, fires, and public CCTV snapshots. Original NEXUS build, from scratch. Not perfect, just real.

**Live:** https://nexus-eye-doublea.netlify.app/

## How to use it

1. Open the live site — the globe loads, feeds start pulling.
2. Drag to spin, pinch or scroll to zoom. Tap a marker for its card.
3. Use the rail on the left to switch layers: QUAKE, ALERTS, LAUNCH, SATS, CCTV, and the rest.
4. Tap a CCTV camera, then SNAPSHOT to see the live frame. Badges tell you straight up if a feed is LIVE, STALE, or PROTO — never fake live.

## Layers

- QUAKE · LIVE (USGS) · STALE/OFFLINE honest fallback
- HAZ · LIVE (NASA EONET natural hazards)
- ALERTS · NWS — active alerts from api.weather.gov (no key). LIVE only when the last pull is < 10 min old; only alerts still in effect are listed.
- LAUNCH · LL2 — upcoming orbital launches from The Space Devs Launch Library 2 (published schedule, not telemetry).
- SATS · SGP4 — 198 satellites from CelesTrak GP elements, positions computed in the browser with SGP4 (satellite.js 5.0.0, self-hosted in `lib/`, MIT).
- ISS · LIVE · WX · LIVE
- AIR · LIVE on CDN when `/api/air` (OpenSky allowlist Function) returns real data; honest PROTO fallback otherwise
- ORBIT · KEPLER
- CCTV · PUBLIC (+ last-good / FRAME OFFLINE) · TxDOT cams via `/api/cam` (allowlisted snapshot Function) + `cctv-pack.json`

## Stack

Three.js r128 (CDN) · satellite.js 5.0.0 (self-hosted, `lib/`) · vanilla JS · single HTML · Netlify Functions · mobile + desktop

## Links

- Live site: https://nexus-eye-doublea.netlify.app/
- NEXUS hub: https://nexus-world-hub.netlify.app/
- Repo: https://github.com/AntManThePro/nexus-eye
- Deep-link example: `?lat=37.77&lon=-122.42&alt=3.2&layers=quake,iss,sats`

## Release

v0.4.5 — SUN/AURORA/FIRE plus city tabs, PREV/nearest-NEXT, CCTV LIVE VERIFIED + CCTV CITY panels.
v0.4.1-launch — LAUNCH layer (LL2 schedule), pad card, paced hourly refresh/backoff/429 handling, STALE after 6h.
v0.4.0-sats — SATS layer (CelesTrak GP + SGP4), satellite card, paced refresh/backoff, tap priority rule, 11 px badges.
v0.3.9-nws — NWS active-alerts layer (polygons, list, detail card, TX filter), touch tap tolerance, expiry/freshness rules.
v0.3.8.1-icon — home-screen icon + PWA manifest. v0.3.8-cctv — CCTV pack. v0.3.7 — HAZ layer, QUAKE honesty fix.
