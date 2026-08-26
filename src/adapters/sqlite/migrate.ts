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
    consumed_at TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS approval_issuance_keys (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, idempotency_key)
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
    kind TEXT NOT NULL CHECK (kind IN ('issue', 'branch', 'pull_request', 'commit', 'sandbox', 'child_session', 'ci_run')),
    value TEXT NOT NULL,
    PRIMARY KEY (campaign_id, kind, value)
  );

  CREATE TABLE IF NOT EXISTS external_action_claims (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
    action_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    current_commit_sha TEXT,
    claimed_campaign_version INTEGER NOT NULL
      CHECK (typeof(claimed_campaign_version) = 'integer' AND claimed_campaign_version >= 1),
    claimed_campaign_status TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'outcome_unknown', 'completed', 'reconciled')),
    attempted_at TEXT NOT NULL,
    lease_started_at TEXT NOT NULL,
    closed_at TEXT,
    disposition TEXT CHECK (disposition IS NULL OR disposition IN ('confirmed_completed', 'confirmed_not_completed')),
    observed_canonical_head TEXT
  );

  CREATE TABLE IF NOT EXISTS campaign_operation_results (
    event_id TEXT PRIMARY KEY REFERENCES campaign_events(id) ON DELETE CASCADE,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('preflight', 'implement', 'verify', 'repair')),
    resulting_campaign_version INTEGER NOT NULL,
    current_commit_sha TEXT NOT NULL,
    pull_request TEXT,
    qodo_iteration INTEGER NOT NULL CHECK (qodo_iteration BETWEEN 0 AND 3),
    child_session_id TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns(status, created_at, id);
  CREATE INDEX IF NOT EXISTS campaign_events_order_idx ON campaign_events(campaign_id, occurred_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS external_action_claims_one_blocking_idx
    ON external_action_claims(campaign_id)
    WHERE status IN ('active', 'outcome_unknown');
  CREATE INDEX IF NOT EXISTS campaign_operation_results_authority_idx
    ON campaign_operation_results(campaign_id, operation, resulting_campaign_version, current_commit_sha, pull_request, qodo_iteration);
`;

export function migrateCampaignStore(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  const foreignKeysEnabled = database.pragma("foreign_keys", { simple: true });
  if (foreignKeysEnabled !== 1 && foreignKeysEnabled !== 1n) {
    throw new Error("SQLite foreign key enforcement could not be enabled");
  }
  database.transaction(() => {
    database.exec(schema);
    const externalReferencesTable = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'external_references'
    `).get() as { sql: string } | undefined;
    if (externalReferencesTable !== undefined && !externalReferencesTable.sql.includes("'commit'")) {
      database.exec(`
        ALTER TABLE external_references RENAME TO external_references_without_commit;
        CREATE TABLE external_references (
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('issue', 'branch', 'pull_request', 'commit', 'sandbox', 'child_session', 'ci_run')),
          value TEXT NOT NULL,
          PRIMARY KEY (campaign_id, kind, value)
        );
        INSERT INTO external_references (campaign_id, kind, value)
        SELECT campaign_id, kind, value FROM external_references_without_commit;
        DROP TABLE external_references_without_commit;
      `);
    }
    const externalActionClaimColumns = database.prepare("PRAGMA table_info(external_action_claims)").all() as { name: string }[];
    if (!externalActionClaimColumns.some(({ name }) => name === "lease_started_at")) {
      database.exec(`
        ALTER TABLE external_action_claims ADD COLUMN lease_started_at TEXT;
        UPDATE external_action_claims SET lease_started_at = attempted_at WHERE lease_started_at IS NULL;
      `);
    }
    const approvalColumns = database.prepare("PRAGMA table_info(approvals)").all() as { name: string }[];
    if (!approvalColumns.some(({ name }) => name === "active")) {
      database.exec("ALTER TABLE approvals ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)); UPDATE approvals SET active = 0 WHERE status <> 'approved';");
    }
    const duplicateLiveApproval = database.prepare(`
      SELECT 1 FROM approvals WHERE status = 'approved' AND active = 1
      GROUP BY campaign_id, action_digest HAVING COUNT(*) > 1 LIMIT 1
    `).get();
    if (duplicateLiveApproval !== undefined) throw new CampaignMigrationConflict();
    database.exec(`
      DROP INDEX IF EXISTS approvals_one_approved_digest_idx;
      CREATE UNIQUE INDEX approvals_one_approved_digest_idx
      ON approvals(campaign_id, action_digest)
      WHERE status = 'approved' AND active = 1
    `);
  })();
}

export class CampaignMigrationConflict extends Error {
  override readonly name = "CampaignMigrationConflict";
  readonly code = "duplicate_live_approvals";
  constructor() { super("Campaign database requires duplicate approval remediation"); }
}

export const migrate = migrateCampaignStore;
