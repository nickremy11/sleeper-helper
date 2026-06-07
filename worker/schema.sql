CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name             TEXT,
  sleeper_username TEXT,
  token_enc     TEXT,
  token_iv      TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);

CREATE TABLE IF NOT EXISTS league_preferences (
  user_id    TEXT    NOT NULL,
  league_id  TEXT    NOT NULL,
  value      INTEGER DEFAULT 0,
  contender  INTEGER DEFAULT 1,
  updated_at INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, league_id)
);

-- ── My Ranks tables ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_rankings (
  user_id     TEXT    NOT NULL,
  player_name TEXT    NOT NULL,
  team        TEXT,
  position    TEXT    NOT NULL,  -- QB | RB | WR | TE
  tier        INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, player_name)
);

CREATE INDEX IF NOT EXISTS idx_rankings_user ON user_rankings(user_id);

CREATE TABLE IF NOT EXISTS user_tier_picks (
  user_id    TEXT    NOT NULL,
  pick_name  TEXT    NOT NULL,
  tier       INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pick_name)
);

CREATE INDEX IF NOT EXISTS idx_picks_user ON user_tier_picks(user_id);

-- ── Named Ranking Sets (imported/saved named sets) ────────────────────────────

CREATE TABLE IF NOT EXISTS named_ranking_sets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_named_sets_user ON named_ranking_sets(owner_user_id);

CREATE TABLE IF NOT EXISTS named_ranking_players (
  set_id      INTEGER NOT NULL,
  player_name TEXT    NOT NULL,
  team        TEXT    DEFAULT '',
  position    TEXT    NOT NULL,
  tier        INTEGER NOT NULL,
  PRIMARY KEY (set_id, player_name)
);

CREATE INDEX IF NOT EXISTS idx_named_players_set ON named_ranking_players(set_id);

CREATE TABLE IF NOT EXISTS named_ranking_set_shares (
  set_id              INTEGER NOT NULL,
  shared_with_user_id TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (set_id, shared_with_user_id)
);

CREATE INDEX IF NOT EXISTS idx_shares_user ON named_ranking_set_shares(shared_with_user_id);

-- Sharing the primary (My Rankings) tier board
CREATE TABLE IF NOT EXISTS user_rankings_shares (
  owner_user_id       TEXT NOT NULL,
  shared_with_user_id TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, shared_with_user_id)
);

CREATE INDEX IF NOT EXISTS idx_ur_shares_viewer ON user_rankings_shares(shared_with_user_id);

-- ── ESPN Settings ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS espn_settings (
  user_id    TEXT    PRIMARY KEY,
  league_ids TEXT    NOT NULL DEFAULT '[]',
  espn_s2    TEXT,
  swid       TEXT,
  updated_at INTEGER
);
