import type Database from "better-sqlite3";

const schema = `
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL COLLATE NOCASE,
    issue_number INTEGER NOT NULL,
    issue_url TEXT NOT NULL,
    parent_session_id TEXT NOT NULL,
    lane TEXT NOT NULL CHECK (lane IN ('easy_win', 'long_term')),
    status TEXT NOT NULL,
    qodo_iteration INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(qodo_iteration) = 'integer' AND qodo_iteration BETWEEN 0 AND 3),
    version INTEGER NOT NULL DEFAULT 1
      CHECK (typeof(version) = 'integer' AND version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repository, issue_number)
  );

  CREATE TABLE IF NOT EXISTS campaign_evidence (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    source_url TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    observation TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('direct', 'inference'))
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('post_issue_comment', 'request_assignment', 'push_branch', 'create_pr', 'update_pr')),
    action_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'consumed')),
    issued_at TEXT NOT NULL,
    expires_at TEXT,
    consumed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS campaign_events (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS qodo_findings (
    id TEXT NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low', 'suggestion')),
    status TEXT NOT NULL CHECK (status IN ('open', 'fixed', 'dismissed')),
    summary TEXT NOT NULL,
    source_url TEXT,
    disposition TEXT,
    iteration INTEGER NOT NULL
      CHECK (typeof(iteration) = 'integer' AND iteration BETWEEN 1 AND 3),
    PRIMARY KEY (campaign_id, id)
  );

  CREATE TABLE IF NOT EXISTS external_references (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('issue', 'branch', 'pull_request', 'sandbox', 'child_session', 'ci_run')),
    value TEXT NOT NULL,
    PRIMARY KEY (campaign_id, kind, value)
  );

  CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns(status, created_at, id);
  CREATE INDEX IF NOT EXISTS campaign_events_order_idx ON campaign_events(campaign_id, occurred_at, id);
`;

export function migrateCampaignStore(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  const foreignKeysEnabled = database.pragma("foreign_keys", { simple: true });
  if (foreignKeysEnabled !== 1 && foreignKeysEnabled !== 1n) {
    throw new Error("SQLite foreign key enforcement could not be enabled");
  }
  database.transaction(() => {
    database.exec(schema);
  })();
}

export const migrate = migrateCampaignStore;
