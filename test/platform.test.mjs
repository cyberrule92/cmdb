// Integration test for the roadmap platform features: RBAC auth, audit,
// CI merge, lifecycle, metrics, CSV — via Fastify inject (no socket).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
process.env.CMDB_DATA_DIR = tmp;
process.env.CMDB_DB = path.join(tmp, 'test.db');
process.env.CMDB_AUTH = '1';                 // enable enforcement
process.env.CMDB_SECRET_KEY = '00'.repeat(32);

const { buildApp } = await import('../src/server.js');
const { ingestGraph } = await import('../src/cmdb/reconcile.js');
const { CIs } = await import('../src/db/repositories.js');
const app = await buildApp();

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const J = (r) => (r.payload ? JSON.parse(r.payload) : {});

// ---- RBAC ----
let r = await app.inject({ method: 'GET', url: '/api/cis' });
assert.equal(r.statusCode, 401, 'no token → 401');
ok('unauthenticated request rejected (401)');

// bootstrap first admin token
r = await app.inject({ method: 'POST', url: '/api/tokens', payload: { name: 'root', role: 'admin' } });
assert.equal(r.statusCode, 200);
const admin = J(r).token;
assert.ok(admin.startsWith('cmdb_'), 'admin token issued');
ok('bootstrap first admin token');

// create a viewer token (needs admin)
r = await app.inject({ method: 'POST', url: '/api/tokens', headers: { authorization: `Bearer ${admin}` }, payload: { name: 'ro', role: 'viewer' } });
const viewer = J(r).token;
ok('admin can create a viewer token');

// viewer can GET but not mutate
r = await app.inject({ method: 'GET', url: '/api/cis', headers: { authorization: `Bearer ${viewer}` } });
assert.equal(r.statusCode, 200, 'viewer GET ok');
r = await app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${viewer}` }, payload: { name: 'x', connector: 'snmp', targets: '1.1.1.1' } });
assert.equal(r.statusCode, 403, 'viewer cannot create job');
ok('RBAC: viewer reads but cannot mutate (403)');

// operator can create a job; but not tokens (admin-only)
r = await app.inject({ method: 'POST', url: '/api/tokens', headers: { authorization: `Bearer ${admin}` }, payload: { name: 'op', role: 'operator' } });
const oper = J(r).token;
r = await app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${oper}` }, payload: { name: 'j', connector: 'ssh', targets: '10.0.0.1' } });
assert.equal(r.statusCode, 200, 'operator creates job');
r = await app.inject({ method: 'POST', url: '/api/tokens', headers: { authorization: `Bearer ${oper}` }, payload: { name: 'nope', role: 'admin' } });
assert.equal(r.statusCode, 403, 'operator cannot manage tokens');
ok('RBAC: operator can create jobs, not tokens');

// ---- audit ----
r = await app.inject({ method: 'GET', url: '/api/audit', headers: { authorization: `Bearer ${admin}` } });
const actions = J(r).map((a) => a.action);
assert.ok(actions.includes('job.create') && actions.includes('token.create'), 'audit recorded actions');
ok('audit log captured mutations');

// ---- metrics (public) ----
r = await app.inject({ method: 'GET', url: '/metrics' });
assert.equal(r.statusCode, 200);
assert.match(r.payload, /opencmdb_cis_total/);
ok('Prometheus /metrics exposed');

// ---- CI merge ----
ingestGraph([
  { _ref: 'a', ci_type: 'Server', name: 'srv-A', source: 'redfish', ids: { serial: 'S1' }, attributes: { model: 'DL380' } },
  { _ref: 'b', ci_type: 'Server', name: 'srv-A-dup', source: 'ssh', ids: { hostname: 'srv-a' }, attributes: { os_name: 'RHEL' } },
], [], null);
const a = CIs.list({ type: 'Server' }).find((c) => c.name === 'srv-A');
const b = CIs.list({ type: 'Server' }).find((c) => c.name === 'srv-A-dup');
r = await app.inject({ method: 'POST', url: '/api/cis/merge', headers: { authorization: `Bearer ${admin}` }, payload: { survivor_id: a.id, victim_id: b.id } });
assert.equal(r.statusCode, 200, 'merge ok');
assert.equal(CIs.get(b.id), undefined, 'victim removed');
const mergedAttrs = JSON.parse(CIs.get(a.id).attributes_json);
assert.equal(mergedAttrs.os_name, 'RHEL', 'victim attributes merged into survivor');
assert.equal(mergedAttrs.model, 'DL380', 'survivor attributes retained');
ok('CI merge reassigns + unions + deletes victim');

// ---- lifecycle sweep ----
// Backdate the surviving CI's last_seen to 10 days ago, then a 7-day sweep
// should mark it stale (fresh CIs must stay active).
const { getDb } = await import('../src/db/index.js');
getDb().prepare(`UPDATE cis SET last_seen = datetime('now','-10 days') WHERE id=?`).run(a.id);
r = await app.inject({ method: 'POST', url: '/api/lifecycle/sweep', headers: { authorization: `Bearer ${admin}` }, payload: { staleDays: 7, decomDays: 9999 } });
assert.equal(r.statusCode, 200);
assert.equal(J(r).stale, 1, 'exactly the 10-day-old CI marked stale');
assert.equal(CIs.get(a.id).status, 'stale', 'CI is now stale');
ok('lifecycle sweep marks only CIs past the stale threshold');

// ---- CSV export ----
r = await app.inject({ method: 'GET', url: '/api/export/inventory.csv', headers: { authorization: `Bearer ${viewer}` } });
assert.equal(r.statusCode, 200);
assert.match(r.headers['content-type'], /csv/);
assert.match(r.payload, /id,ci_type,name/);
ok('CSV export returns filter-aware inventory');

await app.close();
console.log(`\n${pass} checks passed.`);
fs.rmSync(tmp, { recursive: true, force: true });
