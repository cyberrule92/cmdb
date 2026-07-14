-- OpenCMDB schema (SQLite). Data layer is abstracted in repositories.js so this
-- can be ported to Postgres (JSONB) with minimal query changes.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Credential vault. Secret material is AES-256-GCM encrypted in `secret_blob`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credentials (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,            -- redfish | snmpv2c | snmpv3
  username     TEXT,                     -- non-secret hint (redfish user, snmpv3 user)
  secret_blob  TEXT NOT NULL,            -- sealed JSON: {password} | {community} | {authKey,privKey,...}
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Discovery jobs & runs (Data Flow Management equivalent).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovery_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  connector      TEXT NOT NULL,          -- redfish | snmp
  targets        TEXT NOT NULL,          -- newline/comma list of IP, CIDR, or a-b range
  credential_id  INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
  port           INTEGER,                -- optional connector port override
  options_json   TEXT NOT NULL DEFAULT '{}',
  enabled        INTEGER NOT NULL DEFAULT 1,
  schedule_sec   INTEGER,                -- null = manual only; else run every N seconds
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,            -- running | success | failed | partial
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  targets_total    INTEGER DEFAULT 0,
  targets_reached  INTEGER DEFAULT 0,
  cis_created      INTEGER DEFAULT 0,
  cis_updated      INTEGER DEFAULT 0,
  error        TEXT,
  log_json     TEXT NOT NULL DEFAULT '[]'
);

-- ---------------------------------------------------------------------------
-- CMDB core: Configuration Items (CIs) + relationships.
-- Attributes live in attributes_json; hot identity/query fields are promoted
-- to real columns and indexed for the reconciliation engine and UI filters.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cis (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ci_type         TEXT NOT NULL,         -- Server | NetworkDevice | Hypervisor | VM | Storage | Chassis | Manager | Processor | Memory | Drive | NetworkInterface ...
  name            TEXT NOT NULL,
  recon_key       TEXT NOT NULL UNIQUE,  -- deterministic identity key from reconcile.js
  serial          TEXT,
  uuid            TEXT,
  model           TEXT,
  vendor          TEXT,
  mgmt_ip         TEXT,
  hostname        TEXT,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | stale | decommissioned
  source          TEXT,                  -- last connector that touched it
  attributes_json TEXT NOT NULL DEFAULT '{}',
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cis_type   ON cis(ci_type);
CREATE INDEX IF NOT EXISTS idx_cis_serial ON cis(serial);
CREATE INDEX IF NOT EXISTS idx_cis_uuid   ON cis(uuid);
CREATE INDEX IF NOT EXISTS idx_cis_ip     ON cis(mgmt_ip);
CREATE INDEX IF NOT EXISTS idx_cis_host   ON cis(hostname);

-- Alternate identifiers used by reconciliation (MACs, extra IPs, asset tags...).
CREATE TABLE IF NOT EXISTS ci_identifiers (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ci_id    INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,               -- mac | ip | serial | uuid | asset_tag | fqdn
  value    TEXT NOT NULL,
  UNIQUE(kind, value)
);
CREATE INDEX IF NOT EXISTS idx_ident_ci ON ci_identifiers(ci_id);

-- Directed relationships between CIs (topology / containment / dependency).
CREATE TABLE IF NOT EXISTS relationships (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  target_id   INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,            -- contains | runs_on | connected_to | managed_by | member_of
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, target_id, type)
);
CREATE INDEX IF NOT EXISTS idx_rel_src ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_rel_tgt ON relationships(target_id);

-- Change history: every attribute delta the reconciliation engine applies.
CREATE TABLE IF NOT EXISTS ci_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ci_id      INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  run_id     INTEGER REFERENCES discovery_runs(id) ON DELETE SET NULL,
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_changes_ci ON ci_changes(ci_id);

-- ---------------------------------------------------------------------------
-- Access control (opt-in): API tokens with a role, and an audit trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,     -- sha256(token)
  role        TEXT NOT NULL DEFAULT 'viewer',  -- admin | operator | viewer
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_used   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  actor    TEXT,                        -- token name or 'anonymous'
  action   TEXT NOT NULL,               -- e.g. job.run, credential.create, ci.merge
  target   TEXT,
  detail   TEXT,
  ts       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
