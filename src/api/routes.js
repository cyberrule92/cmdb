import { Credentials, Jobs, Runs, CIs, Rels, Tokens, Audit } from '../db/repositories.js';
import { sealSecret } from '../crypto/secrets.js';
import { runJob, isRunning, runLifecycleSweep } from '../discovery/orchestrator.js';
import { CI_TYPES } from '../cmdb/model.js';
import { buildInventoryWorkbook, buildInventoryCsv } from '../export/inventory.js';
import { registerAuth, hashToken, newToken } from './auth.js';

const CONNECTORS = ['redfish', 'snmp', 'vcenter', 'ssh'];
const CRED_TYPES = ['redfish', 'snmpv2c', 'snmpv3', 'vcenter', 'ssh'];

export default async function routes(fastify) {
  registerAuth(fastify);
  const audit = (req, action, target, detail) => Audit.log(req.actor, action, target, detail);

  // ---- meta ---------------------------------------------------------------
  fastify.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString(), auth: fastify.authEnabled }));

  // Prometheus metrics.
  fastify.get('/metrics', async (req, reply) => {
    const byType = CIs.count();
    const runs = Runs.listRecent(200);
    const lines = [
      '# HELP opencmdb_cis_total Total configuration items',
      '# TYPE opencmdb_cis_total gauge',
      `opencmdb_cis_total ${CIs.total()}`,
      '# HELP opencmdb_cis_by_type CIs per type',
      '# TYPE opencmdb_cis_by_type gauge',
      ...byType.map((r) => `opencmdb_cis_by_type{ci_type="${r.ci_type}"} ${r.n}`),
      '# HELP opencmdb_discovery_runs_total Discovery runs by status',
      '# TYPE opencmdb_discovery_runs_total counter',
    ];
    const status = {};
    for (const r of runs) status[r.status] = (status[r.status] || 0) + 1;
    for (const [k, v] of Object.entries(status)) lines.push(`opencmdb_discovery_runs_total{status="${k}"} ${v}`);
    lines.push('# HELP opencmdb_credentials Stored credentials', '# TYPE opencmdb_credentials gauge', `opencmdb_credentials ${Credentials.list().length}`);
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return lines.join('\n') + '\n';
  });

  fastify.get('/api/stats', async () => ({
    total: CIs.total(),
    byType: CIs.count(),
    types: CI_TYPES,
    recentRuns: Runs.listRecent(10),
  }));

  // ---- credentials --------------------------------------------------------
  fastify.get('/api/credentials', async () => Credentials.list());

  fastify.post('/api/credentials', async (req, reply) => {
    const { name, type, username, secret } = req.body || {};
    if (!name || !type || !secret) return reply.code(400).send({ error: 'name, type, secret required' });
    if (!CRED_TYPES.includes(type))
      return reply.code(400).send({ error: `type must be one of ${CRED_TYPES.join('|')}` });
    try {
      const cred = Credentials.create({ name, type, username, secret_blob: sealSecret(secret) });
      audit(req, 'credential.create', name, type);
      return { id: cred.id, name: cred.name, type: cred.type, username: cred.username };
    } catch (e) {
      return reply.code(409).send({ error: e.message });
    }
  });

  fastify.delete('/api/credentials/:id', async (req) => {
    Credentials.remove(Number(req.params.id));
    audit(req, 'credential.delete', req.params.id);
    return { ok: true };
  });

  // ---- jobs ---------------------------------------------------------------
  fastify.get('/api/jobs', async () => Jobs.list().map((j) => ({ ...j, running: isRunning(j.id) })));

  fastify.post('/api/jobs', async (req, reply) => {
    const { name, connector, targets, credential_id, port, options, schedule_sec } = req.body || {};
    if (!name || !connector || !targets)
      return reply.code(400).send({ error: 'name, connector, targets required' });
    if (!CONNECTORS.includes(connector))
      return reply.code(400).send({ error: `connector must be one of ${CONNECTORS.join('|')}` });
    const job = Jobs.create({
      name, connector, targets, credential_id,
      port, options_json: JSON.stringify(options || {}), schedule_sec,
    });
    audit(req, 'job.create', name, connector);
    return job;
  });

  fastify.delete('/api/jobs/:id', async (req) => {
    Jobs.remove(Number(req.params.id));
    audit(req, 'job.delete', req.params.id);
    return { ok: true };
  });

  fastify.get('/api/jobs/:id/runs', async (req) => Runs.listForJob(Number(req.params.id)));

  // Fire-and-forget: the run row is created synchronously; UI polls the run.
  fastify.post('/api/jobs/:id/run', async (req, reply) => {
    const id = Number(req.params.id);
    const job = Jobs.get(id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    if (isRunning(id)) return reply.code(409).send({ error: 'job already running' });
    audit(req, 'job.run', id, job.name);
    runJob(id, fastify.log).catch((e) => fastify.log.error(`job ${id}: ${e.message}`));
    const latest = Runs.listForJob(id, 1)[0];
    return reply.code(202).send({ started: true, run: latest });
  });

  // ---- runs ---------------------------------------------------------------
  fastify.get('/api/runs', async () => Runs.listRecent(25));
  fastify.get('/api/runs/:id', async (req, reply) => {
    const run = Runs.get(Number(req.params.id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    return { ...run, log: JSON.parse(run.log_json || '[]') };
  });

  // ---- configuration items -----------------------------------------------
  fastify.get('/api/cis', async (req) => {
    const { type, q, status, limit, offset } = req.query;
    return CIs.list({
      type, q, status,
      limit: Math.min(Number(limit) || 200, 1000),
      offset: Number(offset) || 0,
    });
  });

  fastify.get('/api/cis/:id', async (req, reply) => {
    const ci = CIs.get(Number(req.params.id));
    if (!ci) return reply.code(404).send({ error: 'not found' });
    return {
      ...ci,
      attributes: JSON.parse(ci.attributes_json || '{}'),
      relationships: Rels.forCi(ci.id),
      changes: CIs.changesFor(ci.id, 50),
    };
  });

  // ---- Excel inventory report ---------------------------------------------
  fastify.get('/api/export/inventory.xlsx', async (req, reply) => {
    const { type, q, status } = req.query;
    const wb = await buildInventoryWorkbook({ type, q, status });
    const buf = await wb.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    const tag = type ? `-${type}` : q ? '-filtered' : '';
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="opencmdb-inventory${tag}-${date}.xlsx"`);
    return reply.send(Buffer.from(buf));
  });

  fastify.get('/api/export/inventory.csv', async (req, reply) => {
    const { type, q, status } = req.query;
    const date = new Date().toISOString().slice(0, 10);
    reply.header('Content-Type', 'text/csv')
      .header('Content-Disposition', `attachment; filename="opencmdb-inventory-${date}.csv"`);
    return buildInventoryCsv({ type, q, status });
  });

  // ---- CI merge (CMDB depth) ----------------------------------------------
  fastify.post('/api/cis/merge', async (req, reply) => {
    const { survivor_id, victim_id } = req.body || {};
    if (!survivor_id || !victim_id) return reply.code(400).send({ error: 'survivor_id and victim_id required' });
    try {
      const ci = CIs.merge(Number(survivor_id), Number(victim_id));
      audit(req, 'ci.merge', `${victim_id}->${survivor_id}`);
      return ci;
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  // ---- CI lifecycle -------------------------------------------------------
  fastify.post('/api/lifecycle/sweep', async (req) => {
    const { staleDays, decomDays } = req.body || {};
    const r = runLifecycleSweep(staleDays, decomDays);
    audit(req, 'lifecycle.sweep', null, JSON.stringify(r));
    return r;
  });
  fastify.post('/api/cis/:id/decommission', async (req, reply) => {
    const ci = CIs.get(Number(req.params.id));
    if (!ci) return reply.code(404).send({ error: 'not found' });
    CIs.update(ci.id, { status: 'decommissioned' });
    audit(req, 'ci.decommission', req.params.id);
    return CIs.get(ci.id);
  });

  // ---- access control: API tokens + audit ---------------------------------
  fastify.get('/api/tokens', async () => Tokens.list());
  fastify.post('/api/tokens', async (req, reply) => {
    const { name, role } = req.body || {};
    if (!name || !['viewer', 'operator', 'admin'].includes(role))
      return reply.code(400).send({ error: 'name and role (viewer|operator|admin) required' });
    const token = newToken();
    const row = Tokens.create({ name, token_hash: hashToken(token), role });
    audit(req, 'token.create', name, role);
    return { ...row, token }; // plaintext returned once
  });
  fastify.delete('/api/tokens/:id', async (req) => {
    Tokens.remove(Number(req.params.id));
    audit(req, 'token.delete', req.params.id);
    return { ok: true };
  });
  fastify.get('/api/audit', async () => Audit.list(200));

  // ---- resource hierarchy tree (Redfish-style) ----------------------------
  fastify.get('/api/cis/:id/tree', async (req, reply) => {
    let rootId = Number(req.params.id);
    if (!CIs.get(rootId)) return reply.code(404).send({ error: 'not found' });
    // scope=machine roots the tree at the selected CI's physical-machine ancestor
    // (e.g. picking a Server shows the whole Chassis it belongs to).
    if (req.query.scope === 'machine') rootId = Rels.rootAncestorOf(rootId);
    const maxDepth = req.query.depth ? Math.max(1, Number(req.query.depth)) : Infinity;
    const seen = new Set();
    const build = (id, rel, level) => {
      if (seen.has(id)) return null;      // guard against cycles
      seen.add(id);
      const ci = CIs.get(id);
      const children = level >= maxDepth ? []
        : Rels.childrenOf(id).map((c) => build(c.id, c.rel, level + 1)).filter(Boolean);
      return { id, rel, ci_type: ci.ci_type, name: ci.name, vendor: ci.vendor, model: ci.model, status: ci.status, children };
    };
    return build(rootId, null, 0);
  });

  fastify.get('/api/roots', async () => Rels.roots());
  fastify.get('/api/servers', async () => CIs.servers());

  // ---- topology graph -----------------------------------------------------
  fastify.get('/api/topology', async (req) => {
    const depth = req.query.depth ? Math.max(1, Number(req.query.depth)) : null;

    // Depth-limited BFS from hierarchy roots (levels of children to expand).
    if (depth) {
      const nodeMap = new Map();
      const edges = [];
      const roots = Rels.roots();
      let frontier = roots.map((r) => { nodeMap.set(r.id, r); return r.id; });
      for (let d = 0; d < depth && frontier.length; d++) {
        const next = [];
        for (const id of frontier) {
          for (const c of Rels.childrenOf(id)) {
            edges.push({ source_id: id, target_id: c.id, type: c.rel });
            if (!nodeMap.has(c.id)) { nodeMap.set(c.id, c); next.push(c.id); }
          }
        }
        frontier = next;
      }
      const nodes = [...nodeMap.values()].map((c) => ({ id: c.id, label: c.name, type: c.ci_type, status: c.status }));
      return { nodes, edges };
    }

    // Whole estate (capped).
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const nodes = CIs.list({ limit }).map((c) => ({
      id: c.id, label: c.name, type: c.ci_type, vendor: c.vendor, status: c.status,
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = Rels.all().filter((e) => ids.has(e.source_id) && ids.has(e.target_id));
    return { nodes, edges };
  });
}
