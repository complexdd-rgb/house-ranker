# House Ranker

A transparent house-shortlisting tool that ranks properties out of 100 using both an objective **House Score** and a configurable **Your Score**.

## Milestone 1 — working static prototype

The first version is intentionally frontend-only so the ranking experience can be tested before external data sources are added.

### Included now

- Ranked property shortlist
- House Score /100 using fixed V1 baseline weights
- Your Score /100 using configurable weights
- Weight editor that must total 100%
- Deal-breaker warnings for budget, bedrooms, commute, flood risk and parking
- Manual Add House form with listing URL
- Per-category score breakdown
- Sort by Your Score, House Score or price
- Local browser persistence via `localStorage`
- Responsive desktop/mobile layout
- Clearly labelled demo properties

## V1 scoring baseline

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

## Planned architecture

### Front end

GitHub Pages will host the static HTML/CSS/JavaScript application.

### Backend

Supabase will later store properties, preferences, raw area metrics, price history, viewing notes and enrichment status. External API keys and enrichment logic should live server-side (for example in Supabase Edge Functions), never in the public GitHub Pages JavaScript.

### Planned data flow

1. Paste a Rightmove/Zoopla/OnTheMarket listing URL.
2. Confirm address, asking price, bedrooms and property type.
3. Save the property.
4. Enrich the address using authorised/public data sources.
5. Store raw measurements separately from calculated scores.
6. Recalculate House Score and Your Score.
7. Rank the shortlist and show deal-breakers.

## Next milestones

1. Connect Supabase and replace local-only storage.
2. Add authentication and Row Level Security.
3. Add EPC enrichment.
4. Add crime and school enrichment.
5. Add Land Registry comparable-sales/value analysis.
6. Add commute, amenities and environmental data.
7. Add viewing notes/status and price-history tracking.
8. Add map and richer property comparison views.

## Run locally

No build step is required. Open `index.html` in a browser, or serve the directory with any simple static web server.

## GitHub Pages

Once GitHub Pages is enabled for the repository's `main` branch, the site can be served directly from the repository root.
