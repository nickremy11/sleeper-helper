# sleeper-helper

Fantasy football toolset at [helper.ffhistorian.com](https://helper.ffhistorian.com). Static
single-page apps (no build step, no frameworks) backed by a Cloudflare Worker API. Works with
**Sleeper** leagues throughout and **ESPN** leagues where noted.

## Features

### Main app (`/`)
- **Guide** — a one-line index of every tool on the site, each entry linking to the thing it describes
- **League Summaries** — standings, record, all-play record and simulated playoff odds for every league at once
- **Rostership** — how many of your leagues each player is on, across Sleeper and ESPN, filterable by position, value, team and league type
- **Lineup Checker** — flags empty slots and injured starters in every league, then builds the optimal lineup and writes it back to Sleeper in one click
- **Weekly Ranks Grid** — your uploaded ranking sheet as seven position columns, with one league's roster painted onto it in green (starting) and red (benched)
- **Player Finder** — search any player for dynasty value plus every roster they're on
- **Waivers** — best available free agents across all leagues, by dynasty value or your own uploaded redraft ranks
- **Open Trades** — every pending trade across your leagues, with player names resolved
- **Trade Partners** — find which leagues you share with another manager
- **Scout** — cross-league trade-opportunity finder: where you're contending and an opponent is rebuilding, or who's stacked at a position
- **Draft Queue** — active drafts with "X picks until your turn"
- **In-Draft Tracker** — live draft board with ADP comparison and targets, for Sleeper and ESPN snake drafts

### Standalone tools
- **League Analyzer** (`/analyzer`) — every team in a league ranked by roster value, positional strength, draft capital and starter strength
- **Trade Analyzer** (`/trade-analyzer`) — build a 2- or 3-team trade and see the before/after effect on roster ranks and playoff odds
- **Auction Draft Tracker** (`/auction`) — live budget, inflation and position scarcity for auction drafts, with ESPN/Sleeper sync or manual/CSV
- **Dispersal** (`/dispersal`) — realtime shared snake draft room for dispersing dynasty rosters
- **Root For Me** (`/rootforme`) — which NFL outcomes help you, based on your contender/rebuilder stance per league
- **My Profile** (`/myprofile`) — account settings, Sleeper auth token, ESPN league credentials

Accounts are optional for read-only browsing but required for ESPN leagues, saved preferences
and stored tokens.

## Structure

```
sleeper-helper/
├── pages/                  ← static, served by Cloudflare Pages (no build step)
│   ├── index.html              ← main app (all tabs)
│   ├── analyzer.html           ← League Analyzer
│   ├── trade-analyzer.html     ← Trade Analyzer
│   ├── auction.html            ← Auction Draft Tracker
│   ├── dispersal.html          ← Dispersal draft rooms
│   ├── rootforme.html          ← Root For Me
│   ├── myprofile.html          ← account + ESPN settings
│   ├── admin.html              ← Site Lead dashboard
│   ├── shared-auth.js          ← auth chip + sign-in modal
│   └── shared-utils.js         ← shared helpers + contender scoring
├── worker/
│   ├── src/index.js        ← Cloudflare Worker (API routes, KV cache, proxies)
│   ├── src/auth.js         ← accounts, sessions, OTP email
│   ├── src/dispersal.js    ← Durable Object for dispersal rooms
│   └── schema.sql          ← D1 schema
└── .github/workflows/
    └── deploy.yml          ← deploys Worker then Pages on push to main
```

## Finding your Sleeper auth token

The Trades tab requires your Sleeper session token to access pending trades via Sleeper's internal API. The token lives in memory only — it is never written to storage and clears when you close the tab.

1. Go to [sleeper.com](https://sleeper.com) and log in
2. Open DevTools → **Network** tab
3. Click on any league or navigate to your trade inbox
4. Filter requests by `graphql`
5. Click any request to `sleeper.com/graphql`
6. Under **Request Headers**, copy the value of the **`Authorization`** header
7. Paste it into the token field on the app and press Enter

Tokens expire periodically — if trades stop loading, repeat the steps above.



### 1. Create KV namespaces

```bash
cd worker
npm install -g wrangler
wrangler login

wrangler kv:namespace create SLEEPER_KV
# → copy the id into wrangler.toml → id = "..."

wrangler kv:namespace create SLEEPER_KV --preview
# → copy into wrangler.toml → preview_id = "..."
```

### 2. Create Cloudflare Pages project

Dashboard → **Pages → Create project → Connect to Git** → select this repo.

- Build command: *(leave empty)*
- Output directory: `pages`
- Project name: `sleeper-helper`

### 3. DNS record (ffhistorian.com)

| Type  | Name     | Target                   | Proxy |
|-------|----------|--------------------------|-------|
| CNAME | `helper` | `sleeper-helper.pages.dev` | ✅ Proxied |

### 4. GitHub secrets

Repo → Settings → Secrets → Actions:

| Secret           | Where to find it |
|------------------|------------------|
| `CF_API_TOKEN`   | Cloudflare → My Profile → API Tokens → Create Token<br>Use "Edit Cloudflare Workers" template; also add Pages:Edit permission |
| `CF_ACCOUNT_ID`  | Cloudflare dashboard right sidebar |

### 5. Push to main — done

The workflow deploys the Worker first (so `/api/*` routes are live), then Pages.

---

## Architecture

```
helper.ffhistorian.com
  │
  ├── /api/players     → Worker → KV (2h TTL) → api.sleeper.app/v1/players/nfl
  ├── /api/sleeper/*   → Worker → api.sleeper.app/v1/*  (live, no cache)
  └── /*               → Pages  → index.html
```

The 2-hour KV cache only applies to the static player database (names, positions,
teams). All other calls — trades, rosters, matchups, drafts — are live with no
caching, so refreshing always returns current data.

## Local dev

Open `pages/index.html` directly in a browser. It detects `file://` and calls
the Sleeper API directly, bypassing the Worker entirely.

For Worker + KV testing:
```bash
cd worker && wrangler dev
```
