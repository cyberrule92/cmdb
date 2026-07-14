// Full-tree Redfish connector test. Spins up a self-signed HTTPS mock that
// serves a representative Redfish resource tree covering EVERY branch shown in
// the target hierarchy, runs the real connector against it, and asserts that a
// first-class CI is produced for each node — then ingests and checks the tree.
import assert from 'node:assert';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-test-'));
process.env.CMDB_DATA_DIR = tmp;
process.env.CMDB_DB = path.join(tmp, 'test.db');
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 1 -subj "/CN=localhost"`, { stdio: 'ignore' });

// ---- mock Redfish resource tree ----
const coll = (...ids) => ({ Members: ids.map((id) => ({ '@odata.id': id })), 'Members@odata.count': ids.length });
const R = {
  '/redfish/v1/': { Systems: { '@odata.id': '/redfish/v1/Systems' }, Chassis: { '@odata.id': '/redfish/v1/Chassis' },
    Managers: { '@odata.id': '/redfish/v1/Managers' }, UpdateService: { '@odata.id': '/redfish/v1/UpdateService' } },

  '/redfish/v1/Systems': coll('/redfish/v1/Systems/1'),
  '/redfish/v1/Systems/1': {
    '@odata.id': '/redfish/v1/Systems/1', Id: '1', Name: 'Compute', HostName: 'esxi-01',
    Manufacturer: 'HPE', Model: 'ProLiant DL380 Gen10', SerialNumber: 'SGH123', UUID: 'uuid-123',
    BiosVersion: 'U30 v2.5', PowerState: 'On', Status: { Health: 'OK', State: 'Enabled' },
    ProcessorSummary: { Count: 2, Model: 'Xeon Gold 6248' }, MemorySummary: { TotalSystemMemoryGiB: 256 },
    Processors: { '@odata.id': '/redfish/v1/Systems/1/Processors' },
    Memory: { '@odata.id': '/redfish/v1/Systems/1/Memory' },
    EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/1/Eth' },
    Storage: { '@odata.id': '/redfish/v1/Systems/1/Storage' },
    Links: { Chassis: [{ '@odata.id': '/redfish/v1/Chassis/1' }], ManagedBy: [{ '@odata.id': '/redfish/v1/Managers/1' }] },
  },
  '/redfish/v1/Systems/1/Processors': coll('/redfish/v1/Systems/1/Processors/1', '/redfish/v1/Systems/1/Processors/2'),
  '/redfish/v1/Systems/1/Processors/1': { Id: '1', Socket: 'Proc 1', Model: 'Xeon Gold 6248', Manufacturer: 'Intel', TotalCores: 20, MaxSpeedMHz: 2500, ProcessorType: 'CPU', Status: { Health: 'OK' } },
  '/redfish/v1/Systems/1/Processors/2': { Id: '2', Socket: 'Proc 2', Model: 'Xeon Gold 6248', Manufacturer: 'Intel', TotalCores: 20, MaxSpeedMHz: 2500, ProcessorType: 'CPU', Status: { Health: 'OK' } },
  '/redfish/v1/Systems/1/Memory': coll('/redfish/v1/Systems/1/Memory/1'),
  '/redfish/v1/Systems/1/Memory/1': { Id: 'proc1dimm1', DeviceLocator: 'PROC 1 DIMM 1', CapacityMiB: 32768, OperatingSpeedMhz: 2933, Manufacturer: 'Samsung', PartNumber: 'M393', SerialNumber: 'DIMMSER1', MemoryDeviceType: 'DDR4', Status: { State: 'Enabled', Health: 'OK' } },
  '/redfish/v1/Systems/1/Eth': coll('/redfish/v1/Systems/1/Eth/1'),
  '/redfish/v1/Systems/1/Eth/1': { Id: '1', Name: 'NIC 1', MACAddress: 'AA:BB:CC:00:11:22', SpeedMbps: 25000, Status: { Health: 'OK' } },
  '/redfish/v1/Systems/1/Storage': coll('/redfish/v1/Systems/1/Storage/1'),
  '/redfish/v1/Systems/1/Storage/1': { Id: 'DE00', Name: 'Smart Array', Drives: [{ '@odata.id': '/redfish/v1/Systems/1/Storage/1/Drives/1' }], Volumes: { '@odata.id': '/redfish/v1/Systems/1/Storage/1/Volumes' } },
  '/redfish/v1/Systems/1/Storage/1/Drives/1': { Id: '1', Model: 'EG0900', Manufacturer: 'HPE', SerialNumber: 'DRVSER1', CapacityBytes: 900000000000, MediaType: 'HDD', Protocol: 'SAS', Status: { Health: 'OK' } },
  '/redfish/v1/Systems/1/Storage/1/Volumes': coll('/redfish/v1/Systems/1/Storage/1/Volumes/1'),
  '/redfish/v1/Systems/1/Storage/1/Volumes/1': { Id: '1', Name: 'os-vol', RAIDType: 'RAID1', CapacityBytes: 900000000000, Status: { Health: 'OK' } },

  '/redfish/v1/Chassis': coll('/redfish/v1/Chassis/1'),
  '/redfish/v1/Chassis/1': {
    '@odata.id': '/redfish/v1/Chassis/1', Id: '1', Name: 'Computer System Chassis', ChassisType: 'RackMount',
    Manufacturer: 'HPE', Model: 'ProLiant DL380 Gen10', SerialNumber: 'SGH123CH', SKU: '868703-B21', Status: { Health: 'OK' },
    NetworkAdapters: { '@odata.id': '/redfish/v1/Chassis/1/NetworkAdapters' },
    PCIeDevices: { '@odata.id': '/redfish/v1/Chassis/1/PCIeDevices' },
    Power: { '@odata.id': '/redfish/v1/Chassis/1/Power' },
    Thermal: { '@odata.id': '/redfish/v1/Chassis/1/Thermal' },
    Links: { ComputerSystems: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
  },
  '/redfish/v1/Chassis/1/NetworkAdapters': coll('/redfish/v1/Chassis/1/NetworkAdapters/1'),
  '/redfish/v1/Chassis/1/NetworkAdapters/1': { Id: '1', Name: 'Adapter', Manufacturer: 'Broadcom', Model: 'BCM57414', SerialNumber: 'NASER1', Status: { Health: 'OK' } },
  '/redfish/v1/Chassis/1/PCIeDevices': coll('/redfish/v1/Chassis/1/PCIeDevices/1'),
  '/redfish/v1/Chassis/1/PCIeDevices/1': { Id: '1', Name: 'Smart Array P408i', Manufacturer: 'HPE', Model: 'P408i-a', SerialNumber: 'PCISER1', DeviceType: 'SingleFunction', Status: { Health: 'OK' } },
  '/redfish/v1/Chassis/1/Power': { PowerSupplies: [
    { MemberId: '0', Name: 'PSU 1', Manufacturer: 'HPE', Model: '865414-B21', SerialNumber: 'PSUSER1', PowerCapacityWatts: 800, Status: { Health: 'OK', State: 'Enabled' } },
    { MemberId: '1', Name: 'PSU 2', Manufacturer: 'HPE', Model: '865414-B21', SerialNumber: 'PSUSER2', PowerCapacityWatts: 800, Status: { Health: 'OK', State: 'Enabled' } },
  ] },
  '/redfish/v1/Chassis/1/Thermal': {
    Fans: [{ MemberId: '0', Name: 'Fan 1', Reading: 25, ReadingUnits: 'Percent', Status: { Health: 'OK' } },
           { MemberId: '1', Name: 'Fan 2', Reading: 26, ReadingUnits: 'Percent', Status: { Health: 'OK' } }],
    Temperatures: [{ MemberId: '0', Name: 'Inlet Ambient', ReadingCelsius: 21, UpperThresholdCritical: 42, Status: { Health: 'OK' } },
                   { MemberId: '1', Name: 'CPU 1', ReadingCelsius: 40, UpperThresholdCritical: 70, Status: { Health: 'OK' } }],
  },

  '/redfish/v1/Managers': coll('/redfish/v1/Managers/1'),
  '/redfish/v1/Managers/1': { '@odata.id': '/redfish/v1/Managers/1', Id: '1', Name: 'Manager', ManagerType: 'BMC', Model: 'iLO 5', FirmwareVersion: '2.44', Manufacturer: 'HPE', Status: { Health: 'OK' }, EthernetInterfaces: { '@odata.id': '/redfish/v1/Managers/1/Eth' } },
  '/redfish/v1/Managers/1/Eth': coll('/redfish/v1/Managers/1/Eth/1'),
  '/redfish/v1/Managers/1/Eth/1': { Id: '1', Name: 'Manager Dedicated Network Interface', MACAddress: 'DE:AD:BE:EF:00:01', SpeedMbps: 1000, Status: { Health: 'OK' } },

  '/redfish/v1/UpdateService': { FirmwareInventory: { '@odata.id': '/redfish/v1/UpdateService/FirmwareInventory' }, SoftwareInventory: { '@odata.id': '/redfish/v1/UpdateService/SoftwareInventory' } },
  '/redfish/v1/UpdateService/FirmwareInventory': coll('/redfish/v1/UpdateService/FirmwareInventory/1', '/redfish/v1/UpdateService/FirmwareInventory/2'),
  '/redfish/v1/UpdateService/FirmwareInventory/1': { Id: 'BMC', Name: 'iLO 5', Version: '2.44', Manufacturer: 'HPE', Updateable: true },
  '/redfish/v1/UpdateService/FirmwareInventory/2': { Id: 'BIOS', Name: 'System ROM', Version: 'U30 v2.50', Updateable: true },
  '/redfish/v1/UpdateService/SoftwareInventory': coll('/redfish/v1/UpdateService/SoftwareInventory/1'),
  '/redfish/v1/UpdateService/SoftwareInventory/1': { Id: 'AgentlessMgmtService', Name: 'Agentless Management Service', Version: '1.4.0' },
};

const server = https.createServer({ key: fs.readFileSync(`${tmp}/k.pem`), cert: fs.readFileSync(`${tmp}/c.pem`) },
  (req, res) => {
    const p = req.url.replace(/\/$/, req.url === '/redfish/v1/' ? '/' : '');
    const body = R[req.url] || R[p];
    if (!body) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const redfish = await import('../src/discovery/connectors/redfish.js');
const cred = { username: 'admin', secret: { password: 'x' } };
const res = await redfish.discover('127.0.0.1', cred, { port, insecure: true });

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

assert.ok(res.reached, 'connector reached the mock');
ok('connector reached Redfish mock');

const byType = {};
for (const n of res.nodes) byType[n.ci_type] = (byType[n.ci_type] || 0) + 1;
const EXPECT = ['Chassis', 'Server', 'Manager', 'NetworkInterface', 'EthernetInterface', 'Processor',
  'Memory', 'Drive', 'Volume', 'NetworkAdapter', 'PCIeDevice', 'PowerSupply', 'Fan', 'TemperatureSensor', 'Firmware', 'Software'];
for (const t of EXPECT) assert.ok(byType[t] > 0, `expected at least one ${t} CI (got ${byType[t] || 0})`);
ok(`all ${EXPECT.length} Redfish CI types produced: ${JSON.stringify(byType)}`);

assert.equal(byType.Processor, 2, '2 processors'); assert.equal(byType.PowerSupply, 2, '2 PSUs');
assert.equal(byType.Fan, 2, '2 fans'); assert.equal(byType.TemperatureSensor, 2, '2 temp sensors');
assert.equal(byType.Firmware, 2, '2 firmware items');
ok('multi-instance components enumerated (2 CPUs / 2 PSUs / 2 fans / 2 temps / 2 firmware)');

// attribute completeness spot-checks
const cpu = res.nodes.find((n) => n.ci_type === 'Processor');
assert.equal(cpu.attributes.total_cores, 20, 'cpu cores captured');
assert.equal(cpu.attributes.max_speed_mhz ?? cpu.attributes.max_speed_m_hz, 2500, 'cpu speed captured');
const temp = res.nodes.find((n) => n.ci_type === 'TemperatureSensor');
assert.equal(temp.attributes.reading_celsius, 21, 'sensor reading captured');
const fw = res.nodes.find((n) => n.ci_type === 'Firmware');
assert.ok(fw.attributes.version, 'firmware version captured');
ok('full attribute sets captured (cores, speed, sensor reading, fw version)');

// hierarchy edges
const hasEdge = (styp, ttyp, rel) => res.edges.some(([s, t, r]) => {
  const sn = res.nodes.find((n) => n._ref === s), tn = res.nodes.find((n) => n._ref === t);
  return sn?.ci_type === styp && tn?.ci_type === ttyp && r === rel;
});
assert.ok(hasEdge('Chassis', 'Server', 'contains'), 'Chassis contains Server');
assert.ok(hasEdge('Server', 'Manager', 'managed_by'), 'Server managed_by Manager');
assert.ok(hasEdge('Server', 'Processor', 'contains'), 'Server contains Processor');
assert.ok(hasEdge('Chassis', 'Fan', 'contains'), 'Chassis contains Fan');
assert.ok(hasEdge('Manager', 'NetworkInterface', 'contains'), 'Manager contains NetworkInterface');
ok('hierarchy edges correct (chassis▸server▸cpu, server▸bmc, chassis▸fan, bmc▸nic)');

// ingest + reconcile + tree
const { ingestGraph } = await import('../src/cmdb/reconcile.js');
const { CIs, Rels } = await import('../src/db/repositories.js');
const stats = ingestGraph(res.nodes, res.edges, null);
assert.equal(stats.created, res.nodes.length, 'all CIs ingested');
assert.equal(CIs.total(), res.nodes.length, 'CI count matches');
ok(`ingested ${stats.created} CIs into CMDB with no collisions`);

// re-ingest idempotent
const s2 = ingestGraph(res.nodes, res.edges, null);
assert.equal(s2.created, 0, 're-ingest creates nothing');
assert.equal(CIs.total(), res.nodes.length, 'no duplicates on re-run');
ok('idempotent re-ingest of full tree — no duplicates');

// tree walk from chassis reaches components
const chassis = CIs.list({ type: 'Chassis' })[0];
const kids = Rels.childrenOf(chassis.id);
assert.ok(kids.some((k) => k.ci_type === 'Server'), 'chassis tree includes server');
assert.ok(kids.some((k) => k.ci_type === 'PowerSupply'), 'chassis tree includes PSU');
ok('containment tree navigable from Chassis root');

console.log(`\n${pass} assertions passed.  Total CIs from one baremetal: ${res.nodes.length}`);
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
