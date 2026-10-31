# Security Policy — NEXUS EYE

## Reporting a vulnerability
Please report security issues privately through GitHub's **Report a vulnerability** button on the Security tab of this repository (private vulnerability reporting). Do not open a public issue.

## Scope
- Static client: `index.html`, `NEXUS-EYE.html`, `lib/`, icons, manifest.
- Netlify Functions (`netlify/functions/`): `/api/cam` is an allowlisted TxDOT snapshot decoder (not an open proxy) with rate limiting, size cap and a `CAM_DISABLED` kill switch; `/api/air` is a read-only proxy.

## Design rules
- No API keys or secrets in this repository. Keyed services read from deploy-environment variables only.
- All public data layers are keyless and labeled honestly (LIVE / STALE / OFFLINE / SCHED / PROPAGATED / PROTO).
- Third-party script `lib/satellite-5.0.0.min.js` is self-hosted and loaded with Subresource Integrity.

## Repository protections
- `main` ruleset: no deletion, no force-push, linear history.
- Secret scanning + push protection, Dependabot alerts and security updates enabled.
