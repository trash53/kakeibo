CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,      -- yyyy-MM-dd
  store      TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  payment    TEXT NOT NULL,
  category   TEXT NOT NULL,
  created_at TEXT NOT NULL,      -- ISO8601 (UTC)
  source     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
CREATE TABLE IF NOT EXISTS fixed_costs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  payment    TEXT NOT NULL,
  category   TEXT NOT NULL,
  day        INTEGER NOT NULL,   -- 毎月の支払日(1-31。31は月末に丸める)
  created_at TEXT NOT NULL
);
-- 登録済みの月を記録(履歴から消しても自動再登録されないようにする)
CREATE TABLE IF NOT EXISTS fixed_applied (
  fixed_id TEXT NOT NULL,
  month    TEXT NOT NULL,        -- yyyy-MM
  PRIMARY KEY (fixed_id, month)
);
