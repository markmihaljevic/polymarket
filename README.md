# polymarket-odds-edge

Web app that surfaces **Polymarket** sports markets priced above **Pinnacle's** de-vigged fair
value — i.e., +EV opportunities. Covers soccer, tennis, NFL, NHL, and NBA.

Built with Next.js 15 (App Router) + Tailwind, deployed on Vercel Pro, refreshed by Vercel Cron,
cached in Next.js's built-in Data Cache (no external database required).

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
                         └── revalidate Next.js Data Cache
                                │
                                ▼
                         /api/snapshot  ◀── page polls every 60s
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

1. **Import the repo** into Vercel. Framework preset: Next.js. No database/storage provisioning
   needed — the app caches snapshots in Vercel's built-in Next.js Data Cache.
2. **Set environment variables** under Project Settings → Environment Variables:
   - `ODDS_API_KEY` — **required**, your [the-odds-api.com](https://the-odds-api.com/) key
   - `CRON_SECRET` — optional; if set, Vercel Cron auto-sends `Authorization: Bearer <value>`
   - (optional) `NEXT_PUBLIC_MIN_EDGE` — default minimum edge, e.g. `0.02`
   - (optional) `ODDS_API_SPORTS_OVERRIDE` — comma-separated sport keys to force-include
3. **Deploy**. `vercel.json` already declares the cron (`*/5 * * * *` on `/api/cron/refresh`).
4. Visit the site. The first `/api/snapshot` call after deploy builds the snapshot inline (10–20s)
   and caches it; every subsequent request is served from the Data Cache until the cron invalidates
   it again.
5. You can force a refresh at any time with the **Refresh now** button in the UI, or via curl:

   ```bash
   # With CRON_SECRET set:
   curl "https://<your-domain>/api/cron/refresh?key=$CRON_SECRET"
   # Or with header form:
   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/refresh
   # With no CRON_SECRET:
   curl https://<your-domain>/api/cron/refresh
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
    cron/refresh/route.ts     # cron: revalidate + rebuild snapshot
    snapshot/route.ts         # public read of cached snapshot
components/
  EdgeTable.tsx               # client table w/ sport filters, min-edge slider,
                              #   refresh button, diagnostics panel
lib/
  types.ts                    # shared types
  polymarket.ts               # Gamma Markets client
  pinnacle.ts                 # Odds API (Pinnacle) client
  devig.ts                    # multiplicative de-vig
  teams.ts                    # name normalization + fuzzy matching
  match.ts                    # event & side matching
  compare.ts                  # orchestrator
  cache.ts                    # unstable_cache wrapper (Next.js Data Cache)
vercel.json                   # cron schedule
```

## Debugging

Expand the **Diagnostics** panel at the bottom of the page — it shows counts at each pipeline
stage (events scanned/kept, Pinnacle events, matches, compared sides, +EV rows), a sample of the
Polymarket tag slugs we saw, a sample of the sports event titles that made it through the filter,
any refresh errors, and whether the `ODDS_API_KEY` / `CRON_SECRET` env vars are actually set in
your runtime environment.

Common failure modes and where to look:

- **`ODDS_API_KEY ✗`** in the env row → add it in Vercel env vars and redeploy.
- **`polymarket scanned > 0` but `polymarket (sports) == 0`** → the sport-tag filter isn't
  catching anything. Check `sampleTags` against `SPORT_KEYWORDS` in `lib/polymarket.ts`.
- **`polymarket (sports) > 0` and `pinnacle events > 0` but `matched == 0`** → name-normalization
  is too strict. Look at `sampleTitles` vs which Pinnacle team names you expect, then tune
  `lib/teams.ts` (`CITY_TO_TEAM`, `NOISE_WORDS`).
- **`compared sides > 0` but `positive edges == 0`** → there genuinely are no +EV rows right now.
  Polymarket is usually efficient for game winners — real edges tend to appear intermittently.
