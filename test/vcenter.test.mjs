// vCenter connector test against a mock vSphere Automation REST API (HTTPS).
import assert from 'node:assert';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-test-'));
process.env.CMDB_DATA_DIR = tmp;
process.env.CMDB_DB = path.join(tmp, 'test.db');
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 1 -subj "/CN=localhost"`, { stdio: 'ignore' });

const HOSTS = [
  { host: 'host-1', name: 'esxi1.dc', connection_state: 'CONNECTED', power_state: 'POWERED_ON' },
  { host: 'host-2', name: 'esxi2.dc', connection_state: 'CONNECTED', power_state: 'POWERED_ON' },
];
const VMS = [
  { vm: 'vm-1', name: 'app01', power_state: 'POWERED_ON', cpu_count: 4, memory_size_MiB: 8192 },
  { vm: 'vm-2', name: 'db01', power_state: 'POWERED_ON', cpu_count: 8, memory_size_MiB: 16384 },
];
const CLUSTERS = [{ cluster: 'domain-c1', name: 'Prod-Cluster', drs_enabled: true, ha_enabled: true }];
const DS = [{ datastore: 'datastore-1', name: 'vsanDatastore', type: 'VSAN', capacity: 10e12, free_space: 4e12 }];

const server = https.createServer({ key: fs.readFileSync(`${tmp}/k.pem`), cert: fs.readFileSync(`${tmp}/c.pem`) }, (req, res) => {
  const u = new URL(req.url, 'https://x');
  const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/api/session' && req.method === 'POST') return send('sess-abc');
  if (u.pathname === '/api/session' && req.method === 'DELETE') { res.writeHead(204); return res.end(); }
  if (u.pathname === '/api/vcenter/cluster') return send(CLUSTERS);
  if (u.pathname === '/api/vcenter/host') {
    return send(HOSTS); // both hosts in the single cluster
  }
  if (u.pathname === '/api/vcenter/datastore') return send(DS);
  if (u.pathname === '/api/vcenter/vm') {
    const h = u.searchParams.get('hosts');
    if (h === 'host-1') return send([VMS[0]]);
    if (h === 'host-2') return send([VMS[1]]);
    return send(VMS);
  }
  res.writeHead(404); res.end('{}');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const vcenter = await import('../src/discovery/connectors/vcenter.js');
const res = await vcenter.discover('127.0.0.1', { username: 'administrator@vsphere.local', secret: { password: 'x' } }, { port, insecure: true });

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

assert.ok(res.reached, 'connector reached mock vCenter');
ok('logged in and reached vCenter');

const byType = {};
for (const n of res.nodes) byType[n.ci_type] = (byType[n.ci_type] || 0) + 1;
assert.equal(byType.Cluster, 1, '1 cluster'); assert.equal(byType.Hypervisor, 2, '2 hosts');
assert.equal(byType.VM, 2, '2 VMs'); assert.equal(byType.Datastore, 1, '1 datastore');
ok(`produced Cluster/Hypervisor/VM/Datastore CIs: ${JSON.stringify(byType)}`);

const has = (styp, ttyp, rel) => res.edges.some(([s, t, r]) => {
  const sn = res.nodes.find((n) => n._ref === s), tn = res.nodes.find((n) => n._ref === t);
  return sn?.ci_type === styp && tn?.ci_type === ttyp && r === rel;
});
assert.ok(has('Cluster', 'Hypervisor', 'contains'), 'cluster contains host');
assert.ok(has('VM', 'Hypervisor', 'runs_on'), 'VM runs_on host');
assert.ok(has('Hypervisor', 'Datastore', 'connected_to'), 'host connected_to datastore');
ok('relationships: cluster▸host, vm runs_on host, host↔datastore');

const vm = res.nodes.find((n) => n.ci_type === 'VM');
assert.ok(vm.attributes.cpu_count && vm.attributes.memory_mib, 'VM has cpu/memory attributes');
ok('VM attributes captured (cpu_count, memory_mib)');

const { ingestGraph } = await import('../src/cmdb/reconcile.js');
const { CIs } = await import('../src/db/repositories.js');
const stats = ingestGraph(res.nodes, res.edges, null);
assert.equal(stats.created, res.nodes.length, 'all vCenter CIs ingested');
ok(`ingested ${stats.created} CIs; idempotent re-ingest: ${ingestGraph(res.nodes, res.edges, null).created === 0 ? 'yes' : 'no'}`);

console.log(`\n${pass} assertions passed. CIs: ${res.nodes.length}`);
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
