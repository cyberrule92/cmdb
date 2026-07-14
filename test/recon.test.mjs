// Reconciliation-engine test. Runs against a throwaway DB (no product data).
// Validates: insert, idempotent re-ingest, cross-source identity merge via MAC,
// relationship creation, and change tracking.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CMDB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdb-test-'));
process.env.CMDB_DB = path.join(process.env.CMDB_DATA_DIR, 'test.db');

const { ingestGraph, upsertCI } = await import('../src/cmdb/reconcile.js');
const { CIs, Rels } = await import('../src/db/repositories.js');

let pass = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); pass++; };

// --- 1. Ingest a Redfish-shaped server graph ---------------------------------
const redfishNodes = [
  { _ref: 's1', ci_type: 'Server', name: 'esxi-01', source: 'redfish',
    ids: { serial: 'SGH1234ABC', uuid: 'uuid-1', mac: ['aa:bb:cc:00:11:22'], mgmt_ip: '10.0.0.50', hostname: 'esxi-01' },
    attributes: { vendor: 'HPE', model: 'ProLiant DL380 Gen10', memory_gib: 256 } },
  { _ref: 'c1', ci_type: 'Processor', name: 'Xeon Gold 6248', source: 'redfish',
    ids: { serial: 'SGH1234ABC:cpu:1' }, attributes: { cores: 20 } },
  { _ref: 'm1', ci_type: 'Manager', name: 'iLO 5', source: 'redfish',
    ids: { serial: 'SGH1234ABC:bmc:1' }, attributes: { firmware_version: '2.44' } },
];
const redfishEdges = [['s1', 'c1', 'contains'], ['s1', 'm1', 'managed_by']];

let stats = ingestGraph(redfishNodes, redfishEdges, null);
assert.equal(stats.created, 3, 'first ingest creates 3 CIs');
assert.equal(stats.updated, 0);
ok('first Redfish ingest creates Server + Processor + Manager');

const server = CIs.getByReconKey('Server|serial:sgh1234abc');
assert.ok(server, 'server keyed by serial');
assert.equal(server.model, 'ProLiant DL380 Gen10');
ok('server promoted columns populated');

assert.equal(Rels.forCi(server.id).length, 2, 'server has 2 relationships');
ok('relationships created (contains + managed_by)');

// --- 2. Idempotent re-ingest (no duplicates) ---------------------------------
stats = ingestGraph(redfishNodes, redfishEdges, null);
assert.equal(stats.created, 0, 're-ingest creates nothing');
assert.equal(stats.updated, 3, 're-ingest updates existing');
assert.equal(CIs.total(), 3, 'still 3 CIs total');
ok('idempotent re-ingest — no duplicates');

// --- 3. Cross-source merge: SNMP sees same box by MAC ------------------------
// SNMP discovers the same physical host by its MAC (no serial known to SNMP).
const snmpNode = { _ref: 'd1', ci_type: 'Server', name: 'esxi-01.dc.local', source: 'snmp',
  ids: { mac: ['aa:bb:cc:00:11:22'], hostname: 'esxi-01.dc.local', mgmt_ip: '10.0.0.51' },
  attributes: { sys_descr: 'VMware ESXi 7.0', vendor: 'HPE' } };
stats = ingestGraph([snmpNode], [], null);
assert.equal(stats.created, 0, 'SNMP host reconciles to existing server via MAC');
assert.equal(CIs.total(), 3, 'no new CI created — merged by MAC');
ok('cross-source identity merge via shared MAC');

const merged = CIs.get(server.id);
const attrs = JSON.parse(merged.attributes_json);
assert.equal(attrs.sys_descr, 'VMware ESXi 7.0', 'SNMP attributes merged into server');
assert.equal(attrs.model, 'ProLiant DL380 Gen10', 'Redfish attributes retained');
ok('attributes merged from both sources');

const changes = CIs.changesFor(server.id);
assert.ok(changes.some((c) => c.field === 'hostname'), 'hostname change tracked');
ok('change history recorded on merge');

// --- 4. A genuinely different device stays separate --------------------------
stats = ingestGraph([{ _ref: 'x', ci_type: 'NetworkDevice', name: 'core-sw-1', source: 'snmp',
  ids: { serial: 'FDO999', hostname: 'core-sw-1', mgmt_ip: '10.0.0.1' },
  attributes: { vendor: 'Cisco' } }], [], null);
assert.equal(stats.created, 1, 'distinct device creates a new CI');
assert.equal(CIs.total(), 4);
ok('distinct device not falsely merged');

console.log(`\n${pass} assertions passed.`);
fs.rmSync(process.env.CMDB_DATA_DIR, { recursive: true, force: true });
