PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS homes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  CONSTRAINT chk_homes_name_not_empty CHECK (length(trim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  name TEXT NOT NULL,
  CONSTRAINT chk_members_name_not_empty CHECK (length(trim(name)) > 0),
  CONSTRAINT fk_members_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  title TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  CONSTRAINT chk_bills_title_not_empty CHECK (length(trim(title)) > 0),
  CONSTRAINT chk_bills_total_positive CHECK (total_cents > 0),
  CONSTRAINT fk_bills_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_at TEXT DEFAULT NULL,
  idempotency_key TEXT DEFAULT NULL,
  CONSTRAINT chk_shares_amount_non_negative CHECK (amount_cents >= 0),
  CONSTRAINT chk_shares_payment_state CHECK (
    (paid_at IS NULL AND idempotency_key IS NULL) OR
    (paid_at IS NOT NULL AND idempotency_key IS NOT NULL)
  ),
  CONSTRAINT uq_shares_bill_member UNIQUE (bill_id, member_id),
  CONSTRAINT fk_shares_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  CONSTRAINT fk_shares_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_members_home_id ON members(home_id);
CREATE INDEX IF NOT EXISTS idx_bills_home_id ON bills(home_id);
CREATE INDEX IF NOT EXISTS idx_shares_bill_id ON shares(bill_id);
CREATE INDEX IF NOT EXISTS idx_shares_member_id ON shares(member_id);