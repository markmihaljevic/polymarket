# polymarket-odds-edge

Web app that surfaces **Polymarket** sports markets priced above **Pinnacle's** de-vigged fair
value — i.e., +EV opportunities. Covers soccer, tennis, NFL, NHL, and NBA.

Built with Next.js 15 (App Router) + Tailwind, deployed on Vercel Pro, refreshed by Vercel Cron,
cached in Upstash Redis (via the Vercel Marketplace integration).

## How it works

```
 ┌───────────────┐   ┌──────────────────────┐
 │  Polymarket   │   │   The Odds API       │
 │  Gamma API    │   │  (Pinnacle, h2h)     │
 └───────┬───────┘   └──────────┬───────────┘
         │                      │
         ▼                      ▼
     Vercel Cron ──▶  /api/cron/refresh (every 5 min)
                         │
                         ├── match events (team-name fuzzy + ±6h)
                         ├── de-vig Pinnacle (multiplicative)
                         ├── compare PM price vs fair prob
                         └── write snapshot to Upstash Redis
                                │
                                ▼
                         /api/snapshot  ◀── page polls every 30s
```

Only rows where **PM implied probability < Pinnacle de-vigged probability**
(equivalently, PM decimal odds > fair decimal odds) are shown.

## Local development

```bash
npm install
cp .env.local.example .env.local
# fill in ODDS_API_KEY and CRON_SECRET
npm run dev
```

Then trigger one refresh manually (KV will fall back to an in-memory cache if KV env vars aren't set):

```bash
curl -X POST http://localhost:3000/api/cron/refresh \
  -H "Authorization: Bearer $CRON_SECRET"
```

Visit [http://localhost:3000](http://localhost:3000).

## Deploying to Vercel

1. **Import the repo** into Vercel. Framework preset: Next.js.
2. **Provision a Redis store**: Vercel dashboard → Storage → Marketplace → Upstash Redis. Create
   a free database and link it to this project; `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or the
   `UPSTASH_REDIS_REST_*` equivalents) are injected automatically.
3. **Set environment variables**:
   - `ODDS_API_KEY` — your [the-odds-api.com](https://the-odds-api.com/) key
   - `CRON_SECRET` — any random string; Vercel Cron sends it as `Authorization: Bearer <value>`
   - (optional) `NEXT_PUBLIC_MIN_EDGE` — default minimum edge, e.g. `0.02`
   - (optional) `ODDS_API_SPORTS_OVERRIDE` — comma-separated sport keys to force-include
4. **Deploy**. `vercel.json` already declares the cron (`*/5 * * * *` on `/api/cron/refresh`).
5. After the first deploy, Vercel will hit the cron within ~5 minutes; until then `/api/snapshot`
   returns `503`. You can kick off the first refresh manually from the Vercel dashboard
   (Deployments → latest → Functions → `/api/cron/refresh` → Invoke) or with curl:

   ```bash
   curl https://<your-vercel-domain>/api/cron/refresh \
     -H "Authorization: Bearer $CRON_SECRET"
   ```

## Odds API quota planning

The Odds API is billed per request. Our cron makes roughly one call per active sport every run.
With ~20 active sport keys and a 5-minute cron, that's ~288 × 20 = **~5,800 requests/day** ≈
**175k/month**, which needs the $120 tier during peak season (all five sports in play).

To cut usage:

- Raise the cron interval in `vercel.json` (e.g. `*/10 * * * *` halves it).
- Use `ODDS_API_SPORTS_OVERRIDE` to restrict to specific leagues.
- Out-of-season sports are automatically skipped because `/sports` returns `active:false`.

## Caveats

- **API shapes**: I wrote the Polymarket Gamma API and Odds API clients from memory; both have
  quirks (stringified JSON arrays, differing tag taxonomies, etc.) and the code parses defensively
  but may still miss edge cases. Check the refresh endpoint's response and the "warnings" panel at
  the bottom of the page after the first run.
- **Matching**: team-name fuzzy matching handles ~95% of cases. Misses show up as lower
  `matchedEvents` counts in the stats. If you see a specific team that's failing, extend the
  `CITY_TO_TEAM` map or add a case to `lib/teams.ts`.
- **Moneyline only**: this v1 compares h2h / match-winner markets. Spreads and totals are not
  supported.
- **Edge threshold**: default minimum is 2%. Anything tighter is usually within the noise of
  matching/timing slippage — Pinnacle's true probabilities aren't _that_ exact, and PM prices move.

## File tour

```
app/
  page.tsx                    # server page, renders the table
  layout.tsx                  # root layout + global styles
  globals.css                 # tailwind entry
  api/
    cron/refresh/route.ts     # cron: rebuild snapshot -> KV
    snapshot/route.ts         # public read of cached snapshot
components/
  EdgeTable.tsx               # client table w/ sport filters + min-edge slider
lib/
  types.ts                    # shared types
  polymarket.ts               # Gamma Markets client
  pinnacle.ts                 # Odds API (Pinnacle) client
  devig.ts                    # multiplicative de-vig
  teams.ts                    # name normalization + fuzzy matching
  match.ts                    # event & side matching
  compare.ts                  # orchestrator
  kv.ts                       # Vercel KV wrapper
vercel.json                   # cron schedule
```
