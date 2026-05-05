# sleeper-helper

Read-only Sleeper fantasy dashboard at [helper.ffhistorian.com](https://helper.ffhistorian.com).

## Features

- **Trades** — pending trades across all your leagues with player names resolved
- **Player finder** — search any player, see every roster they're on + injury status
- **Lineup check** — scan all starting lineups for empty slots or injured starters
- **Availability** — search a player and see which leagues they're a free agent in
- **Draft queue** — active drafts with "X picks until your turn" + manual refresh
- **League settings** — scoring, roster spots, IR/taxi, waiver type, and more

## Structure

```
sleeper-helper/
├── pages/
│   └── index.html          ← full single-page app (static, no build step)
├── worker/
│   ├── src/index.js        ← Cloudflare Worker (KV cache + Sleeper proxy)
│   └── wrangler.toml       ← Worker config (fill in KV namespace IDs here)
└── .github/workflows/
    └── deploy.yml          ← deploys Worker then Pages on push to main
```

## First-time setup

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
