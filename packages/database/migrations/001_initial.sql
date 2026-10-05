-- ChessAnalyser initial schema (spec §34). Never edit an applied migration; add a new numbered file.

CREATE TABLE profiles (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  username      TEXT NOT NULL COLLATE NOCASE,
  created_at    TEXT NOT NULL,
  last_sync_at  TEXT,
  UNIQUE (source, username)
);

CREATE TABLE games (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  source          TEXT NOT NULL,
  source_game_id  TEXT NOT NULL,
  url             TEXT,
  pgn             TEXT NOT NULL,
  white_username  TEXT NOT NULL,
  black_username  TEXT NOT NULL,
  white_rating    INTEGER,
  black_rating    INTEGER,
  result          TEXT NOT NULL,
  played_at       TEXT NOT NULL,
  time_control    TEXT NOT NULL,
  time_class      TEXT NOT NULL,
  eco             TEXT,
  opening_name    TEXT,
  variant         TEXT NOT NULL DEFAULT 'standard',
  supported       INTEGER NOT NULL DEFAULT 1,
  user_colour     TEXT,
  start_fen       TEXT NOT NULL,
  ply_count       INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (source, source_game_id)
);
CREATE INDEX games_profile_played ON games (profile_id, played_at DESC);

CREATE TABLE moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply         INTEGER NOT NULL,
  san         TEXT NOT NULL,
  uci         TEXT NOT NULL,
  fen_before  TEXT NOT NULL,
  fen_after   TEXT NOT NULL,
  UNIQUE (game_id, ply)
);

-- Engine results are keyed by position + full engine configuration, never by game (spec §22).
CREATE TABLE engine_analyses (
  id                 TEXT PRIMARY KEY,
  fen_hash           TEXT NOT NULL,
  fen                TEXT NOT NULL,
  engine             TEXT NOT NULL,
  engine_version     TEXT NOT NULL,
  preset             TEXT NOT NULL,
  config_hash        TEXT NOT NULL,
  config_json        TEXT NOT NULL,
  capabilities_json  TEXT NOT NULL,
  nodes              INTEGER,
  depth              INTEGER,
  white_cp           INTEGER,
  mate_for_white_in  INTEGER,
  terminal_json      TEXT,
  white_win          REAL,
  draw               REAL,
  black_win          REAL,
  created_at         TEXT NOT NULL,
  UNIQUE (fen_hash, config_hash)
);
CREATE INDEX engine_analyses_lookup ON engine_analyses (fen_hash, engine, engine_version, preset, config_hash);

CREATE TABLE engine_lines (
  id             TEXT PRIMARY KEY,
  analysis_id    TEXT NOT NULL REFERENCES engine_analyses(id) ON DELETE CASCADE,
  rank           INTEGER NOT NULL,
  root_move_uci  TEXT NOT NULL,
  root_move_san  TEXT NOT NULL,
  evaluation     TEXT NOT NULL,
  wdl_json       TEXT,
  moves_json     TEXT NOT NULL
);
CREATE INDEX engine_lines_analysis ON engine_lines (analysis_id, rank);

-- Which cached analysis was used for each position of a reviewed game.
CREATE TABLE game_positions (
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply          INTEGER NOT NULL,
  analysis_id  TEXT NOT NULL REFERENCES engine_analyses(id) ON DELETE CASCADE,
  engine       TEXT NOT NULL,
  PRIMARY KEY (game_id, ply)
);

CREATE TABLE move_reviews (
  id                     TEXT PRIMARY KEY,
  game_id                TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply                    INTEGER NOT NULL,
  mover                  TEXT NOT NULL,
  played_move_san        TEXT NOT NULL,
  played_move_uci        TEXT NOT NULL,
  classification         TEXT NOT NULL,
  badges_json            TEXT NOT NULL,
  evaluation_before      TEXT NOT NULL,
  evaluation_after       TEXT NOT NULL,
  expected_score_best    REAL,
  expected_score_played  REAL,
  expected_score_loss    REAL,
  best_move_uci          TEXT,
  best_move_san          TEXT,
  best_line_id           TEXT,
  tags_json              TEXT NOT NULL,
  explanation            TEXT NOT NULL,
  engine                 TEXT NOT NULL,
  engine_version         TEXT NOT NULL,
  algorithm_version      INTEGER NOT NULL,
  verified               INTEGER NOT NULL DEFAULT 0,
  reduced                INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE (game_id, ply)
);

CREATE TABLE variations (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  starting_ply  INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('engine', 'user', 'ai_selected')),
  created_by    TEXT NOT NULL,
  moves_json    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL
);

CREATE TABLE sync_cache (
  url            TEXT PRIMARY KEY,
  etag           TEXT,
  last_modified  TEXT,
  last_checked   TEXT NOT NULL
);

CREATE TABLE import_failures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id      TEXT,
  archive_url     TEXT,
  source_game_id  TEXT,
  error           TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE mcp_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  tool       TEXT NOT NULL,
  game_id    TEXT,
  ply        INTEGER,
  line_id    TEXT,
  result     TEXT NOT NULL
);
