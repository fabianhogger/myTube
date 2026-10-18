# MyTube

A local-only YouTube clone that ingests your own feed, judges every video against
a system prompt **you** write, and shows you only the ones that pass. Nothing is
hosted; everything runs on your machine against your own account.

```
filter-prompt.md  ──┐
                    ├─► Claude ─► verdicts (SQLite) ─► feed grid ─► /watch/[id]
YouTube ────────────┘
  A: OAuth subscriptions → per-channel RSS (zero API quota)
  B: Playwright scrape of your logged-in Home + Subscriptions
```

Videos that fail the filter are **hidden completely** from the UI. Their verdicts
are still stored, so you can audit them with `npm run verdicts -- --blocked` and
tune the prompt.

## Setup

```bash
npm install
cp .env.local.example .env.local      # then fill it in
```

`.env.local` needs an `ANTHROPIC_API_KEY`, plus `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` from a Google Cloud project with **YouTube Data API v3**
enabled. `YOUTUBE_API_KEY` from the same project is optional:

| Credential | Used for | Required? |
|---|---|---|
| OAuth client | `subscriptions.list` — your subscription list | **yes**, it is private data an API key cannot read |
| `YOUTUBE_API_KEY` | `videos.list` — duration and view count | optional; public data, but it keeps enrichment working when the OAuth token is missing or expired |
| `ANTHROPIC_API_KEY` | judging videos | **yes** |

Create an OAuth client of type **Desktop app** and register exactly this
redirect URI:

```
http://localhost:3000/api/auth/google/callback
```

Then connect the two sources. Each is a one-time step:

```bash
npm run oauth:login    # source A: read your subscription list
npm run yt:login       # source B: sign in to the browser profile the scraper reuses
```

`yt:login` opens a real browser window. Sign in, accept any cookie dialog, and it
closes itself once it sees the session cookie. Google invalidates this session
every few weeks — rerun it when the scrape stage reports `not_signed_in`.

By default that window is Playwright's bundled Chromium. To use another
Chromium-based browser instead, set `MYTUBE_CHROME_PATH` (e.g. `/snap/bin/brave`)
or `MYTUBE_CHROME_CHANNEL=chrome`. Two constraints worth knowing: Playwright
cannot drive Firefox-family or snap-confined browsers for this, and it always
uses **its own** profile at `data/chrome-profile` rather than your browser's
existing one — it needs a profile it owns so it can relaunch it headlessly and
unattended. So you sign in once in that window whichever binary you choose.

## Daily use

```bash
npm run dev            # http://localhost:3000
npm run ingest         # pull new videos and judge them
```

The **Refresh feed** button in the UI spawns the exact same `scripts/ingest.ts`,
so there is only one code path to debug. Ingest runs in a detached child process
and reports progress through SQLite, so it survives a dev-server restart and the
UI reconnects to a run already in flight.

```bash
npm run ingest -- --only=rss,filter   # run selected stages
npm run ingest -- --dry-run           # apply migrations, run nothing
npm run filter                        # re-judge after editing filter-prompt.md
npm run verdicts                      # summary: counts, spend, prompt history
npm run verdicts -- --blocked         # why videos were hidden  <- the tuning loop
npm run verdicts -- --video <id>      # one video across every prompt you've tried
npm run verdicts -- --diff <hash>     # what changed between two prompts
```

Stages: `subscriptions`, `rss`, `enrich`, `scrape_home`, `scrape_subs`, `filter`.

## Tuning the filter

`filter-prompt.md` is the whole product. Edit it, run `npm run filter`, look at
`npm run verdicts -- --blocked`, repeat.

Verdicts are keyed on `(video_id, prompt_hash)`, where the hash covers the prompt
text, the model and a pipeline version. Three consequences worth knowing:

- **Editing the prompt re-judges everything** (~$0.003/video, so ~$0.60 per 200).
  `npm run filter` tells you the count and estimated cost before it starts.
- **Reverting an edit costs nothing.** The old verdicts were never deleted, so the
  previous feed comes straight back with zero API calls.
- **You can compare prompts** with `--diff`, which is the only honest way to tell
  whether an edit actually helped.

Whitespace-only edits don't trigger a re-filter; the prompt is normalized before
hashing.

## How the feed is built

Both sources write into one `videos` table keyed by YouTube's video id, with
field-level precedence `api > rss > scrape` — a weaker source never overwrites a
stronger value. A video first seen by the scraper carries an approximate date
(`published_approx = 1`) which is upgraded in place when RSS supplies the exact
timestamp.

Ordering is a score computed at query time (it decays with wall-clock time, so
storing it would be wrong): recency, plus a bonus for ranking high in your
scraped Home grid, plus a bonus for being corroborated by both sources, plus a
small subscription bias.

## When something breaks

Source B is scraping, so it *will* break when YouTube reshapes its renderers.
The design assumes this:

- A stage failing makes the run `partial`, never `failed`. A broken scraper
  degrades you to the RSS feed; it never empties your grid.
- **Zero extracted videos is treated as a failure, not an empty feed.** Otherwise
  a renderer rename would read as "YouTube showed me nothing" and recommendations
  would silently stop behind a green checkmark.
- Every extraction failure dumps the raw payload to `data/debug/`. That file is
  what makes the fix quick: diff it against `fixtures/ytInitialData-home.json`.
- Scrape writes are upsert-only. A broken scrape can never delete rows.

Named failures tell you what to run: `not_signed_in`, `consent_wall`,
`bot_check`, `profile_locked`, `not_authorized`, `no_items_extracted`. If YouTube
serves a bot interstitial, retry with `MYTUBE_SCRAPE_HEADLESS=0`.

Re-capture fixtures after a shape change: `npm run fixtures` (or
`npm run fixtures -- --public`, which needs no login).

## Tests

```bash
npm run smoke       # merge precedence, fail-soft paths, prompt-hash behaviour
npm run typecheck
npm run lint
```

The smoke suite seeds its own throwaway database at `data/test.db` from the
fixtures, so it runs on a clean checkout and never touches your real feed. It is
fully offline and spends no money (`MYTUBE_FAKE_LLM=1` decides verdicts with a
local regex). To exercise the whole pipeline against your real database without
credentials:

```bash
MYTUBE_OFFLINE=1 MYTUBE_FAKE_LLM=1 npm run ingest
```

`MYTUBE_OFFLINE=1` serves every network source from `fixtures/`, which hold real
captured YouTube payloads with session identifiers stripped.

## Layout

| Path | What's there |
|---|---|
| `filter-prompt.md` | your filter (gitignored; seeded from `.example`) |
| `src/lib/` | db singleton, migrations, repositories, formatting |
| `src/ingest/google/` | OAuth, `subscriptions.list`, `videos.list` enrichment |
| `src/ingest/rss/` | conditional-GET feed polling and parsing |
| `src/ingest/scrape/` | Playwright, `ytInitialData` extraction, renderer walks |
| `src/ingest/filter/` | prompt assembly, batching, retry, verdict persistence |
| `src/app/` | feed grid, watch page, API routes |
| `scripts/` | ingest, filter, verdicts, logins, fixtures, smoke tests |
| `data/` | SQLite, browser profile, logs, debug dumps (all gitignored) |

## Notes

- Scraping your logged-in feed is against YouTube's Terms of Service. It reads
  only your own feed, locally, but that is the tradeoff you are making. Source A
  (OAuth + RSS) uses documented APIs and public feeds only; if you'd rather stay
  inside the ToS, run `npm run ingest -- --only=subscriptions,rss,enrich,filter`.
- `npm audit` reports advisories in eslint's dependency chain. They are dev-only,
  and the "fix" downgrades Next to 14.
