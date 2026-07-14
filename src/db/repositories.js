import { getDb } from './index.js';

const db = getDb();

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
export const Credentials = {
  create({ name, type, username, secret_blob }) {
    const stmt = db.prepare(
      `INSERT INTO credentials (name, type, username, secret_blob) VALUES (?,?,?,?)`
    );
    const info = stmt.run(name, type, username ?? null, secret_blob);
    return this.get(info.lastInsertRowid);
  },
  get(id) { return db.prepare(`SELECT * FROM credentials WHERE id=?`).get(id); },
  list() {
    // Never leak secret_blob to the API layer.
    return db.prepare(`SELECT id,name,type,username,created_at FROM credentials ORDER BY id`).all();
  },
  remove(id) { return db.prepare(`DELETE FROM credentials WHERE id=?`).run(id); },
};

// ---------------------------------------------------------------------------
// Discovery jobs & runs
// ---------------------------------------------------------------------------
export const Jobs = {
  create({ name, connector, targets, credential_id, port, options_json, schedule_sec }) {
    const info = db.prepare(
      `INSERT INTO discovery_jobs (name,connector,targets,credential_id,port,options_json,schedule_sec)
       VALUES (?,?,?,?,?,?,?)`
    ).run(name, connector, targets, credential_id ?? null, port ?? null,
          options_json ?? '{}', schedule_sec ?? null);
    return this.get(info.lastInsertRowid);
  },
  get(id) { return db.prepare(`SELECT * FROM discovery_jobs WHERE id=?`).get(id); },
  list() { return db.prepare(`SELECT * FROM discovery_jobs ORDER BY id`).all(); },
  listScheduled() {
    return db.prepare(`SELECT * FROM discovery_jobs WHERE enabled=1 AND schedule_sec IS NOT NULL`).all();
  },
  remove(id) { return db.prepare(`DELETE FROM discovery_jobs WHERE id=?`).run(id); },
};

export const Runs = {
  start(job_id, targets_total) {
    const info = db.prepare(
      `INSERT INTO discovery_runs (job_id,status,targets_total) VALUES (?, 'running', ?)`
    ).run(job_id, targets_total);
    return info.lastInsertRowid;
  },
  finish(id, { status, targets_reached, cis_created, cis_updated, error, log }) {
    db.prepare(
      `UPDATE discovery_runs SET status=?, finished_at=datetime('now'),
        targets_reached=?, cis_created=?, cis_updated=?, error=?, log_json=?
       WHERE id=?`
    ).run(status, targets_reached ?? 0, cis_created ?? 0, cis_updated ?? 0,
          error ?? null, JSON.stringify(log ?? []), id);
  },
  get(id) { return db.prepare(`SELECT * FROM discovery_runs WHERE id=?`).get(id); },
  listForJob(job_id, limit = 20) {
    return db.prepare(`SELECT * FROM discovery_runs WHERE job_id=? ORDER BY id DESC LIMIT ?`)
      .all(job_id, limit);
  },
  listRecent(limit = 25) {
    return db.prepare(`SELECT * FROM discovery_runs ORDER BY id DESC LIMIT ?`).all(limit);
  },
};

// ---------------------------------------------------------------------------
// Configuration Items
// ---------------------------------------------------------------------------
export const CIs = {
  getByReconKey(key) { return db.prepare(`SELECT * FROM cis WHERE recon_key=?`).get(key); },
  get(id) { return db.prepare(`SELECT * FROM cis WHERE id=?`).get(id); },

  findByIdentifier(kind, value, ci_type = null) {
    if (ci_type) {
      return db.prepare(
        `SELECT c.* FROM cis c JOIN ci_identifiers i ON i.ci_id=c.id
         WHERE i.kind=? AND i.value=? AND c.ci_type=?`
      ).get(kind, value, ci_type);
    }
    return db.prepare(
      `SELECT c.* FROM cis c JOIN ci_identifiers i ON i.ci_id=c.id
       WHERE i.kind=? AND i.value=?`
    ).get(kind, value);
  },

  insert(ci) {
    const info = db.prepare(
      `INSERT INTO cis (ci_type,name,recon_key,serial,uuid,model,vendor,mgmt_ip,hostname,source,attributes_json)
       VALUES (@ci_type,@name,@recon_key,@serial,@uuid,@model,@vendor,@mgmt_ip,@hostname,@source,@attributes_json)`
    ).run(ci);
    return this.get(info.lastInsertRowid);
  },

  update(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return this.get(id);
    const set = cols.map((c) => `${c}=@${c}`).join(', ');
    db.prepare(`UPDATE cis SET ${set}, last_seen=datetime('now') WHERE id=@id`)
      .run({ ...fields, id });
    return this.get(id);
  },

  touch(id) { db.prepare(`UPDATE cis SET last_seen=datetime('now') WHERE id=?`).run(id); },

  addIdentifier(ci_id, kind, value) {
    if (value == null || value === '') return;
    db.prepare(`INSERT OR IGNORE INTO ci_identifiers (ci_id,kind,value) VALUES (?,?,?)`)
      .run(ci_id, kind, String(value));
  },

  recordChange(ci_id, run_id, field, oldV, newV) {
    db.prepare(
      `INSERT INTO ci_changes (ci_id,run_id,field,old_value,new_value) VALUES (?,?,?,?,?)`
    ).run(ci_id, run_id ?? null, field,
          oldV == null ? null : String(oldV), newV == null ? null : String(newV));
  },

  changesFor(ci_id, limit = 50) {
    return db.prepare(`SELECT * FROM ci_changes WHERE ci_id=? ORDER BY id DESC LIMIT ?`)
      .all(ci_id, limit);
  },

  list({ type, q, status, limit = 200, offset = 0 } = {}) {
    const where = [];
    const params = {};
    if (type)   { where.push('ci_type=@type'); params.type = type; }
    if (status) { where.push('status=@status'); params.status = status; }
    if (q) {
      where.push(`(name LIKE @q OR serial LIKE @q OR mgmt_ip LIKE @q OR hostname LIKE @q OR model LIKE @q OR vendor LIKE @q)`);
      params.q = `%${q}%`;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.limit = limit; params.offset = offset;
    return db.prepare(
      `SELECT id,ci_type,name,serial,model,vendor,mgmt_ip,hostname,status,source,first_seen,last_seen
       FROM cis ${clause} ORDER BY ci_type, name LIMIT @limit OFFSET @offset`
    ).all(params);
  },

  count() {
    return db.prepare(`SELECT ci_type, COUNT(*) n FROM cis GROUP BY ci_type`).all();
  },

  // Full rows incl. attributes_json — used by the Excel export. Honours the same
  // {type, q, status} filter as list() so exports match the inventory view.
  allFull({ type, q, status } = {}) {
    const where = [];
    const params = {};
    if (type)   { where.push('ci_type=@type'); params.type = type; }
    if (status) { where.push('status=@status'); params.status = status; }
    if (q) {
      where.push(`(name LIKE @q OR serial LIKE @q OR mgmt_ip LIKE @q OR hostname LIKE @q OR model LIKE @q OR vendor LIKE @q)`);
      params.q = `%${q}%`;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM cis ${clause} ORDER BY ci_type, name`).all(params);
  },
  total() { return db.prepare(`SELECT COUNT(*) n FROM cis`).get().n; },

  // Compute systems for the topology server picker.
  servers() {
    return db.prepare(
      `SELECT id, ci_type, name, model, vendor, mgmt_ip, hostname FROM cis
       WHERE ci_type IN ('Server','Hypervisor') ORDER BY name`
    ).all();
  },

  markStaleBefore(isoTs) {
    return db.prepare(
      `UPDATE cis SET status='stale' WHERE last_seen < ? AND status='active'`
    ).run(isoTs);
  },
  decommissionBefore(isoTs) {
    return db.prepare(
      `UPDATE cis SET status='decommissioned' WHERE last_seen < ? AND status IN ('active','stale')`
    ).run(isoTs);
  },

  // Merge victim CI into survivor: reassign identifiers/relationships/history,
  // union attributes (survivor wins), then delete the victim. Returns survivor.
  merge(survivorId, victimId) {
    if (survivorId === victimId) throw new Error('cannot merge a CI into itself');
    const survivor = this.get(survivorId), victim = this.get(victimId);
    if (!survivor || !victim) throw new Error('survivor or victim not found');
    return transaction(() => {
      db.prepare(`UPDATE OR IGNORE ci_identifiers SET ci_id=? WHERE ci_id=?`).run(survivorId, victimId);
      db.prepare(`DELETE FROM ci_identifiers WHERE ci_id=?`).run(victimId);
      db.prepare(`UPDATE OR IGNORE relationships SET source_id=? WHERE source_id=?`).run(survivorId, victimId);
      db.prepare(`UPDATE OR IGNORE relationships SET target_id=? WHERE target_id=?`).run(survivorId, victimId);
      db.prepare(`DELETE FROM relationships WHERE source_id=? OR target_id=? OR source_id=target_id`).run(victimId, victimId);
      db.prepare(`UPDATE ci_changes SET ci_id=? WHERE ci_id=?`).run(survivorId, victimId);
      const merged = { ...JSON.parse(victim.attributes_json || '{}'), ...JSON.parse(survivor.attributes_json || '{}') };
      const fill = {};
      for (const f of ['serial', 'uuid', 'model', 'vendor', 'mgmt_ip', 'hostname'])
        if (!survivor[f] && victim[f]) fill[f] = victim[f];
      db.prepare(`UPDATE cis SET attributes_json=@a WHERE id=@id`).run({ a: JSON.stringify(merged), id: survivorId });
      if (Object.keys(fill).length) this.update(survivorId, fill);
      this.recordChange(survivorId, null, 'merge', `ci#${victimId} (${victim.name})`, `merged into ci#${survivorId}`);
      db.prepare(`DELETE FROM cis WHERE id=?`).run(victimId);
      return this.get(survivorId);
    });
  },
};

// ---------------------------------------------------------------------------
// API tokens (opt-in auth) + audit trail
// ---------------------------------------------------------------------------
export const Tokens = {
  create({ name, token_hash, role }) {
    const info = db.prepare(`INSERT INTO api_tokens (name,token_hash,role) VALUES (?,?,?)`)
      .run(name, token_hash, role);
    return db.prepare(`SELECT id,name,role,created_at FROM api_tokens WHERE id=?`).get(info.lastInsertRowid);
  },
  findByHash(hash) { return db.prepare(`SELECT * FROM api_tokens WHERE token_hash=?`).get(hash); },
  touch(id) { db.prepare(`UPDATE api_tokens SET last_used=datetime('now') WHERE id=?`).run(id); },
  list() { return db.prepare(`SELECT id,name,role,created_at,last_used FROM api_tokens ORDER BY id`).all(); },
  count() { return db.prepare(`SELECT COUNT(*) n FROM api_tokens`).get().n; },
  remove(id) { return db.prepare(`DELETE FROM api_tokens WHERE id=?`).run(id); },
};

export const Audit = {
  log(actor, action, target, detail) {
    db.prepare(`INSERT INTO audit_log (actor,action,target,detail) VALUES (?,?,?,?)`)
      .run(actor || 'anonymous', action, target ?? null, detail ?? null);
  },
  list(limit = 100) { return db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit); },
};

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------
export const Rels = {
  upsert(source_id, target_id, type) {
    if (!source_id || !target_id || source_id === target_id) return;
    db.prepare(
      `INSERT INTO relationships (source_id,target_id,type) VALUES (?,?,?)
       ON CONFLICT(source_id,target_id,type) DO UPDATE SET last_seen=datetime('now')`
    ).run(source_id, target_id, type);
  },
  forCi(ci_id) {
    return db.prepare(
      `SELECT r.*, s.name AS source_name, s.ci_type AS source_type,
              t.name AS target_name, t.ci_type AS target_type
       FROM relationships r
       JOIN cis s ON s.id=r.source_id
       JOIN cis t ON t.id=r.target_id
       WHERE r.source_id=? OR r.target_id=?`
    ).all(ci_id, ci_id);
  },
  all() {
    return db.prepare(`SELECT source_id,target_id,type FROM relationships`).all();
  },
  allDetailed() {
    return db.prepare(
      `SELECT r.source_id, r.target_id,
              s.name AS source, s.ci_type AS source_type, r.type AS rel,
              t.name AS target, t.ci_type AS target_type
       FROM relationships r JOIN cis s ON s.id=r.source_id JOIN cis t ON t.id=r.target_id
       ORDER BY s.ci_type, s.name`
    ).all();
  },
  // Direct children via containment edges (contains / managed_by).
  childrenOf(ci_id) {
    return db.prepare(
      `SELECT c.id, c.ci_type, c.name, c.vendor, c.model, c.status, r.type AS rel
       FROM relationships r JOIN cis c ON c.id = r.target_id
       WHERE r.source_id = ? AND r.type IN ('contains','managed_by')
       ORDER BY c.ci_type, c.name`
    ).all(ci_id);
  },
  // Walk up containment edges to the topmost ancestor (the physical machine
  // root, e.g. the Chassis that contains a selected Server).
  rootAncestorOf(ci_id) {
    const seen = new Set();
    let cur = ci_id;
    for (;;) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const parent = db.prepare(
        `SELECT source_id FROM relationships WHERE target_id=? AND type='contains' LIMIT 1`
      ).get(cur);
      if (!parent) break;
      cur = parent.source_id;
    }
    return cur;
  },
  // CIs that are not contained by anything (hierarchy roots) — Chassis/Server tops.
  roots() {
    return db.prepare(
      `SELECT c.id, c.ci_type, c.name, c.vendor, c.model, c.status FROM cis c
       WHERE c.id NOT IN (
         SELECT target_id FROM relationships WHERE type IN ('contains','managed_by')
       ) ORDER BY c.ci_type, c.name`
    ).all();
  },
};

export function transaction(fn) {
  return db.transaction(fn)();
}
