-- Review Algorithm 2 (V2 plan §47): existing V1 reviews stay intact. Reviews are now unique per
-- (game, ply, algorithm version), and V2 detail (metrics, insights, structured explanation,
-- diagnostics, engine configuration) is stored as JSON.

CREATE TABLE move_reviews_new (
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
  details_json           TEXT,
  created_at             TEXT NOT NULL,
  UNIQUE (game_id, ply, algorithm_version)
);

INSERT INTO move_reviews_new (
  id, game_id, ply, mover, played_move_san, played_move_uci, classification, badges_json,
  evaluation_before, evaluation_after, expected_score_best, expected_score_played, expected_score_loss,
  best_move_uci, best_move_san, best_line_id, tags_json, explanation, engine, engine_version,
  algorithm_version, verified, reduced, details_json, created_at
)
SELECT
  id, game_id, ply, mover, played_move_san, played_move_uci, classification, badges_json,
  evaluation_before, evaluation_after, expected_score_best, expected_score_played, expected_score_loss,
  best_move_uci, best_move_san, best_line_id, tags_json, explanation, engine, engine_version,
  algorithm_version, verified, reduced, NULL, created_at
FROM move_reviews;

DROP TABLE move_reviews;
ALTER TABLE move_reviews_new RENAME TO move_reviews;
CREATE INDEX move_reviews_game ON move_reviews (game_id, algorithm_version, ply);

-- User variations can branch from one another (V2 plan §42).
ALTER TABLE variations ADD COLUMN parent_id TEXT;
ALTER TABLE variations ADD COLUMN branch_index INTEGER;
