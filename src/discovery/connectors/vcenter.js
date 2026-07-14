import axios from 'axios';
import https from 'node:https';
import { config } from '../../config.js';

// vCenter / ESXi connector via the vSphere Automation REST API (vCenter 7+ /api,
// with fallback to 6.5+ /rest). Produces Cluster, Hypervisor (host), VM and
// Datastore CIs with runs_on / contains / connected_to relationships.
//
// cred (from vault): { username, secret:{ password } }
// opts: { port=443, insecure=true }

function agent(opts) { return new https.Agent({ rejectUnauthorized: opts.insecure === false }); }

async function login(base, cred, opts) {
  const ax = axios.create({ baseURL: base, timeout: config.discovery.connectTimeoutMs, httpsAgent: agent(opts) });
  // vCenter 7+: POST /api/session → "session-id" (JSON string). 6.5+: /rest/com/vmware/cis/session → {value}
  try {
    const r = await ax.post('/api/session', null, { auth: { username: cred.username, password: cred.secret.password } });
    return { prefix: '/api', sid: r.data };
  } catch {
    const r = await ax.post('/rest/com/vmware/cis/session', null, { auth: { username: cred.username, password: cred.secret.password } });
    return { prefix: '/rest', sid: r.data.value };
  }
}

// /api returns bare arrays; /rest wraps in { value: [...] }.
const unwrap = (data) => (data && data.value !== undefined ? data.value : data);

export async function discover(host, cred, opts = {}) {
  const port = opts.port || 443;
  const base = `https://${host}:${port}`;
  const log = [];
  let session;
  try {
    session = await login(base, cred, opts);
  } catch (err) {
    return { reached: false, error: `vcenter login failed: ${err.response?.status || err.code || err.message}`, nodes: [], edges: [] };
  }
  const client = axios.create({
    baseURL: base + session.prefix, timeout: config.discovery.connectTimeoutMs,
    httpsAgent: agent(opts), headers: { 'vmware-api-session-id': session.sid },
  });
  const get = async (path, params) => unwrap((await client.get(path, { params })).data);

  const nodes = [], edges = [];
  const add = (ci_type, ref, name, ids, attributes) => { nodes.push({ _ref: ref, ci_type, name, source: 'vcenter', ids, attributes }); return ref; };
  const link = (s, t, ty) => { if (s && t) edges.push([s, t, ty]); };

  // Clusters -----------------------------------------------------------------
  let clusters = [];
  try { clusters = await get('/vcenter/cluster'); } catch (e) { log.push(`cluster: ${e.message}`); }
  const clusterRef = {};
  for (const c of clusters) {
    const ref = `clu-${host}-${c.cluster}`;
    clusterRef[c.cluster] = ref;
    add('Cluster', ref, c.name, { serial: `vcenter:${host}:cluster:${c.cluster}` },
      { drs_enabled: c.drs_enabled ?? null, ha_enabled: c.ha_enabled ?? null, moid: c.cluster });
  }

  // Datastores ---------------------------------------------------------------
  let datastores = [];
  try { datastores = await get('/vcenter/datastore'); } catch (e) { log.push(`datastore: ${e.message}`); }
  const dsRef = {};
  for (const d of datastores) {
    const ref = `ds-${host}-${d.datastore}`;
    dsRef[d.datastore] = ref;
    add('Datastore', ref, d.name, { serial: `vcenter:${host}:ds:${d.datastore}` },
      { type: d.type || null, capacity_bytes: d.capacity ?? null, free_bytes: d.free_space ?? null, moid: d.datastore });
  }

  // Hosts (hypervisors) ------------------------------------------------------
  let hosts = [];
  try { hosts = await get('/vcenter/host'); } catch (e) { log.push(`host: ${e.message}`); }
  const hostRef = {};
  for (const h of hosts) {
    const ref = `esxi-${host}-${h.host}`;
    hostRef[h.host] = ref;
    add('Hypervisor', ref, h.name, { serial: `vcenter:${host}:host:${h.host}`, hostname: h.name },
      { connection_state: h.connection_state || null, power_state: h.power_state || null, moid: h.host, vcenter: host });
    // cluster membership
    for (const c of clusters) {
      try {
        const inClu = await get('/vcenter/host', { clusters: c.cluster });
        if (inClu.some((x) => x.host === h.host)) link(clusterRef[c.cluster], ref, 'contains');
      } catch { /* filter unsupported on some builds */ }
    }
    // datastores reachable from host
    try {
      const hds = await get('/vcenter/datastore', { hosts: h.host });
      for (const d of hds) link(ref, dsRef[d.datastore], 'connected_to');
    } catch { /* ignore */ }
  }

  // VMs ----------------------------------------------------------------------
  let vms = [];
  try { vms = await get('/vcenter/vm'); } catch (e) { log.push(`vm: ${e.message}`); }
  for (const v of vms) {
    const ref = `vm-${host}-${v.vm}`;
    add('VM', ref, v.name, { serial: `vcenter:${host}:vm:${v.vm}`, hostname: v.name },
      {
        power_state: v.power_state || null,
        cpu_count: v.cpu_count ?? null,
        memory_mib: v.memory_size_MiB ?? null,
        moid: v.vm, vcenter: host,
      });
    // place VM on its host
    for (const h of hosts) {
      try {
        const onHost = await get('/vcenter/vm', { hosts: h.host });
        if (onHost.some((x) => x.vm === v.vm)) { link(ref, hostRef[h.host], 'runs_on'); break; }
      } catch { /* ignore */ }
    }
  }

  // best-effort logout
  try { await client.delete('/session'); } catch { /* ignore */ }

  return {
    reached: hosts.length > 0 || vms.length > 0,
    nodes, edges, log,
    summary: `${clusters.length} cluster(s), ${hosts.length} host(s), ${vms.length} VM(s), ${datastores.length} datastore(s)`,
  };
}
