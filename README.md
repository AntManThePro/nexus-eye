# NEXUS EYE v0.4.9

Field-ops planet console by DoubleA (@AntManThePro). A photoreal globe with live public intel — quakes, weather alerts, launches, satellites, aurora, fires, volcanoes, and public CCTV snapshots. Original NEXUS build, from scratch. Not perfect, just real.

**Live:** https://nexus-eye-doublea.netlify.app/

## How to use it

1. Open the live site — the globe loads, feeds start pulling.
2. Drag to spin, pinch or scroll to zoom. Tap a marker for its card.
3. Use the rail on the left to switch layers: QUAKE, ALERTS, LAUNCH, SATS, CCTV, and the rest.
4. Tap a CCTV camera, then SNAPSHOT to see the live frame. Badges tell you straight up if a feed is LIVE, STALE, or OFFLINE — never fake live.

## Layers

- QUAKE · LIVE (USGS) · STALE/OFFLINE honest fallback
- HAZ · LIVE (NASA EONET natural hazards)
- ALERTS · NWS — active alerts from api.weather.gov (no key). LIVE only when the last pull is < 10 min old AND the NWS `updated` time is present, not in the future, and not older than 60 min; only alerts still in effect are listed. A malformed pull (no good rows, or >10% bad rows) keeps last-good as STALE.
- LAUNCH · LL2 — upcoming orbital launches from The Space Devs Launch Library 2 (published schedule, not telemetry).
- SATS · SGP4 — 198 satellites from CelesTrak GP elements, positions computed in the browser with SGP4 (satellite.js 5.0.0, self-hosted in `lib/`, MIT).
- ISS · LIVE · WX · LIVE
- AIR · LIVE when `/api/air` returns a proved, fresh set from community ADS-B (adsb.lol, ODbL 1.0), Texas first of six fixed regions. A failed refresh keeps last-good positions as STALE for up to 5 minutes, then OFFLINE. Nothing is simulated. Contains information from adsb.lol, made available under the ODbL 1.0.
- FIRE · NASA FIRMS MODIS C6.1 24h thermal hotspots via `/api/fire` (off unless the rail or a deep-link turns it on). LIVE after a successful pull; STALE keeps last-good points; OFFLINE draws nothing. Thermal detections, not ground truth.
- VOLC · USGS volcano alert levels and aviation color codes via `/api/volc` (off unless the rail or a deep-link turns it on). LIVE after a successful pull; STALE keeps last-good markers; OFFLINE draws nothing. Smithsonian GVP Holocene dots are dim static context, never labelled LIVE. Official alert levels, not a forecast.
- ORBIT · KEPLER
- CCTV · PUBLIC 8,334-cam catalog (4 dead TxDOT cameras removed) · `/api/cam` names failures and holds a last-good frame as STALE. "NO NEW FRAME" only if the source re-stamped identical bytes (frozen) or nothing changed for 3× cadence (min 10 min). ALERTS · NWS is LIVE only when our pull is < 10 min old AND the NWS `updated` time is present, not in the future, and not older than 60 min; otherwise STALE (or OFFLINE if we have never pulled).

## Stack

Three.js r128 (CDN) · satellite.js 5.0.0 (self-hosted, `lib/`) · vanilla JS · single HTML · Netlify Functions · mobile + desktop

## Links

- Live site: https://nexus-eye-doublea.netlify.app/
- NEXUS hub: https://nexus-world-hub.netlify.app/
- Repo: https://github.com/AntManThePro/nexus-eye
- Deep-link example: `?lat=37.77&lon=-122.42&alt=3.2&layers=quake,iss,sats`

## Release

v0.4.9 — CCTV/NWS honesty: catalog 8,338 → 8,334 (4 dead TxDOT cams removed); `/api/cam` 9s budget, named failures, last-good STALE; "NO NEW FRAME" only if frozen or 3× cadence (min 10 min); NWS LIVE uses a 60-min source-updated check in addition to the 10-min pull; hidden-layer tap filter. Stacked on v0.4.8.
v0.4.8 — VOLC: USGS Volcano Hazards Program HANS alert levels + aviation color codes, with the Smithsonian GVP Holocene catalog as dim static context, via `/api/volc`. Off unless the rail or `?layers=…,volc` turns it on. Stacked on v0.4.7.
v0.4.7 — TX LIVE: `/api/air` uses a Texas-first community ADS-B proxy (adsb.lol, ODbL 1.0) instead of OpenSky (which blocked this host's cloud IPs and 503'd). AIR is LIVE / STALE / OFFLINE only — the old PROTO simulated planes are gone. Adds `netlify/functions/fire.js` so the existing FIRE layer's `/api/fire` call has a function to hit. Built on v0.4.6 (drift fix, icons, egg, CITY tabs, PREV/nearest-NEXT).
v0.4.6 — Stop idle globe drift; firmer drag friction. Icons, README how-to, footer egg.
v0.4.5 — SUN/AURORA/FIRE plus city tabs, PREV/nearest-NEXT, CCTV LIVE VERIFIED + CCTV CITY panels.
v0.4.1-launch — LAUNCH layer (LL2 schedule), pad card, paced hourly refresh/backoff/429 handling, STALE after 6h.
v0.4.0-sats — SATS layer (CelesTrak GP + SGP4), satellite card, paced refresh/backoff, tap priority rule, 11 px badges.
v0.3.9-nws — NWS active-alerts layer (polygons, list, detail card, TX filter), touch tap tolerance, expiry/freshness rules.
v0.3.8.1-icon — home-screen icon + PWA manifest. v0.3.8-cctv — CCTV pack. v0.3.7 — HAZ layer, QUAKE honesty fix.
