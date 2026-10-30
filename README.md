# Match Model: football + basketball analysis

Light theme by default with a night/day toggle. Switch sport with the Football / Basketball control; pick any league
from the country-grouped dropdown (the list grows automatically with whatever The Odds API currently lists as active).

## What you get
**Football:** Home / Draw / Away %, Over/Under 1.5, 2.5, 3.5, 4.5 with %, BTTS, corners and shots Over/Under ladders,
a confidence level (High/Medium/Low) on every selection, and top picks per match.
**Basketball:** Home/Away win %, points-total ladder with Over/Under %, projected total, confidence levels.
No bookmaker hand-off or bet slips.

## How the numbers are made (be aware of the limits)
| Part | Source | Method |
|---|---|---|
| 10 football leagues (PL, Championship, La Liga, Serie A, Bundesliga, Ligue 1, Eredivisie, Primeira, Brasileirao A, Champions League) | football-data.org | Poisson/Dixon-Coles goal model, blended 60/40 with bookmaker consensus when the market is deep |
| ~30+ other football leagues | The Odds API (+ OddsPapi when a tournament id is known) | de-vigged bookmaker consensus; other goal lines derived from the market's main line (marked "derived") |
| Basketball | The Odds API (+ Pinnacle for NBA/EuroLeague) | de-vigged consensus; totals ladder from a normal distribution around the market line |
| Corners, shots | OddsPapi (Pinnacle) | market-implied only. None of the three APIs provides team corner/shot statistics, and books post these ~3 days before kickoff |

Confidence (0-100) = decisiveness of the probability + match history behind the model + market agreement + bookmaker depth.

## Credits
The Odds API free plan = 500 credits/month. Each league view costs 2 credits (h2h + totals, 1 region) and is cached 6 h.
The app pauses below `ODDS_API_MIN_CREDITS`. Remaining credits show on screen.

## Run locally
```
cd backend && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt
set FOOTBALL_DATA_KEY=... & set ODDS_API_KEY=... & set ODDSPAPI_KEY=...
uvicorn app.main:app --reload
cd web && npm install && npm run dev
```
Deploy as before (Render env vars: see `backend/.env.example`; Vercel `VITE_API_URL`).


## Dates, all leagues and the probability filter

- **League → "All leagues"** loads every league of the chosen sport, a few at a time, and lists the matches by kickoff with the league name on each card. Leagues with no match in the selected dates cost no Odds API credits (a free events check runs first); a league that does have matches costs the usual credits once, then is cached for hours. "All leagues" is not remembered between visits, so opening the app never spends credits on its own.
- **Dates** is a calendar (today up to 30 days ahead). Tap one day to load it, or tap two days to load the whole range. Days are your local days. The API takes `start` / `end` (UTC instants, end exclusive); `days` still works for older clients.
- **Probability range** is a two-handle slider (also keyboard-operable). Only matches with at least one selection inside the range are shown, those selections are listed on the card, and values outside the range are dimmed.

Deploy the backend (Render) before the web app (Vercel). On Render, `CORS_ORIGINS` must include `https://matchmodel.vercel.app`.
