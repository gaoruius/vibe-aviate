# VibeAviate — Air Travel Database Front End

CIS 51 Vibe Coding Assignment · Rui Gao (De Anza ID 20731015)

A static web app that loads the `SB-airlines`, `SB-airports` and `SB-routes` OpenFlights files and answers every query in the browser.

## Features

| Requirement | Page |
|---|---|
| 1.1 / 1.2 Airline or Airport entity by IATA code (all fields) | `#/lookup` |
| 2.1a Airports reached by an airline, ordered by # routes | `#/reports?type=airline` |
| 2.1b Airlines serving an airport, ordered by # routes | `#/reports?type=airport` |
| 2.2 All airlines / all airports ordered by IATA code | `#/directory` |
| 2.3 Student ID and name | `#/about` |
| One-hop S→X→D finder, 0-stop legs, ordered by great-circle miles, top-5 map | `#/onehop` |

Extras:

- Search accepts IATA, ICAO, or part of a name / city, with "did you mean" choices when several match
- Tables: scrollable, filterable, sortable by any column, CSV download of what is shown
- Maps (Leaflet + OpenStreetMap): network map on every report and lookup; clicking a one-hop row draws that route pair
- Charts (Chart.js) — click a bar to drill into that airline or airport
- Light / dark / system theme toggle, mobile layout, per-page titles, shareable URLs
- Interface in English, Simplified Chinese and Spanish (`docs/i18n.js`; defaults to the browser language, choice is remembered). Data values stay in English as they appear in OpenFlights.

## Notes on interpretation

- Routes are directional; "# routes" counts each route that starts **or** ends at the airport.
- One-hop: both legs must have `Stops = 0`; legs may be on different airlines (toggle "Same airline on both legs" to restrict).
- "Top 5 intermediate cities" are ranked by the number of route pairs through that airport.
- `\N` in the source data means no value and is displayed as "—".

## Run locally

```bash
cd docs && python3 -m http.server 8140
```

Then open http://localhost:8140.

## Deploy

`docs/` is the whole site (no build step). GitHub Pages serves it from the `main` branch, `/docs` folder: https://gaoruius.github.io/vibe-aviate/

To show a photo on the Get ID page, add `docs/assets/me.jpg`.
