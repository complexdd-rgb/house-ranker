# House Ranker

A transparent house-shortlisting tool that ranks properties out of 100 using both an objective **House Score** and a configurable **Your Score**.

## Current status

### Phase 1 — GitHub Pages + Supabase foundation

- Ranked property shortlist
- House Score /100 using fixed baseline weights
- Your Score /100 using configurable weights
- Deal-breaker warnings
- Manual Add House flow
- Responsive GitHub Pages frontend
- Supabase Auth and private per-user shortlist/settings sync
- Row Level Security on user-owned data

### Phase 2 — automatic EPC enrichment

When a signed-in user saves a property, House Ranker now:

1. Captures/normalises the postcode from the Add House flow.
2. Calls the authenticated Supabase Edge Function `epc-enrich`.
3. Searches the official MHCLG Energy Performance of Buildings developer API by postcode/address.
4. Scores candidate addresses and only auto-applies a match at 75% confidence or above.
5. Fetches the matched certificate and saves useful EPC fields to Supabase.
6. Saves total floor area to `properties.floor_area_m2`.
7. Saves a compact EPC provenance record plus `energy_score` to `area_metrics`.
8. Replaces the manual Energy metric with the current EPC numerical energy-efficiency rating, clamped to 0–100.
9. Shows EPC band/rating, floor area, match status and a retry action in the UI.

If the certificate lacks a usable numerical current rating, the fallback Energy scores are A=95, B=85, C=72, D=60, E=47, F=32 and G=15. Uncertain matches are marked `needs_review` rather than silently attached to a property.

## EPC API activation

The government API bearer token is intentionally **not** stored in GitHub or browser JavaScript.

Create/sign in to the GOV.UK **Get energy performance of buildings data** service, obtain the developer API bearer token, then add it to the Supabase project as an Edge Function secret named:

`EPC_BEARER_TOKEN`

The deployed function reads it only server-side.

## Scoring baseline

| Category | Weight |
| --- | ---: |
| Price & value | 25 |
| Property | 20 |
| Commute | 15 |
| Schools | 10 |
| Crime & safety | 10 |
| Amenities | 7 |
| Transport | 5 |
| Environment | 5 |
| Energy | 3 |
| **Total** | **100** |

The fixed weights produce the House Score. The user-adjustable weights produce Your Score.

## Architecture

### Front end

GitHub Pages hosts the static HTML/CSS/JavaScript app. `epc.js` progressively enhances the Phase 1 UI and calls the Edge Function only for authenticated users.

### Backend

Supabase stores properties, preferences, enrichment status/provenance, raw area metrics, price history and viewing data. External API credentials remain in Edge Function secrets rather than public GitHub Pages code.

### EPC files

- `epc.js` — browser integration, postcode capture, automatic lookup trigger and EPC UI
- `epc.css` — EPC enrichment UI styles
- `supabase/functions/epc-enrich/index.ts` — authenticated server-side EPC search/match/fetch/store logic

## Next milestones

1. Finish live EPC API activation/testing with the government bearer token.
2. Add crime and school enrichment.
3. Add Land Registry comparable-sales/value analysis.
4. Add commute, amenities and environmental data.
5. Add viewing notes/status and price-history tracking.
6. Add map and richer property comparison views.

## Run locally

No build step is required. Open `index.html` in a browser, or serve the directory with any simple static web server.
