import axios from 'axios';
import https from 'node:https';
import { config } from '../../config.js';

// HPE iLO / DMTF Redfish connector. Walks the FULL Redfish resource tree and
// emits a first-class CI for every node in the hierarchy:
//
//   Chassis ▸ Server(ComputeSystem) ▸ {Processor, Memory, Drive, Volume, EthernetInterface}
//   Chassis ▸ {NetworkAdapter, PCIeDevice(Devices), PowerSupply, Fan, TemperatureSensor}
//   Server  ▸ managed_by ▸ Manager(BMC) ▸ NetworkInterface
//   Server  ▸ {Firmware, Software}   (from UpdateService inventories)
//
// Every resource's full attribute set is preserved via attrsFrom().
//
// cred (from vault): { username, secret:{ password } }
// opts: { port=443, insecure=true }

// -------- helpers ----------------------------------------------------------
const snake = (s) => String(s)
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/[\s-]+/g, '_')
  .toLowerCase();

const SKIP = new Set(['Links', 'Actions', 'Oem', 'Members', 'Status', 'Id', 'Name', 'RelatedItem', 'Redundancy']);

// Capture every meaningful attribute of a Redfish resource (scalars, arrays,
// value-objects), flattening Status and dropping navigation refs / @odata noise.
function attrsFrom(obj, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('@') || SKIP.has(k) || k.endsWith('@odata.count')) continue;
    if (v === null || v === undefined || v === '') continue;
    // skip navigation references like { "@odata.id": "..." } and collections
    if (v && typeof v === 'object' && !Array.isArray(v) && v['@odata.id']) continue;
    out[snake(k)] = v;
  }
  const st = obj?.Status;
  if (st && typeof st === 'object') {
    if (st.Health != null) out.health = st.Health;
    if (st.State != null) out.state = st.State;
    if (st.HealthRollup != null) out.health_rollup = st.HealthRollup;
  }
  return { ...out, ...extra };
}

function makeClient(host, cred, opts) {
  const port = opts.port || 443;
  return axios.create({
    baseURL: `https://${host}:${port}`,
    timeout: config.discovery.connectTimeoutMs,
    auth: { username: cred.username, password: cred.secret.password },
    headers: { Accept: 'application/json', 'OData-Version': '4.0' },
    httpsAgent: new https.Agent({ rejectUnauthorized: opts.insecure === false }),
    validateStatus: (s) => s >= 200 && s < 300,
  });
}

const oid = (o) => o && o['@odata.id'];

async function get(client, path) {
  if (!path) return null;
  const { data } = await client.get(path);
  return data;
}
async function getRef(client, node) { return node ? get(client, oid(node)) : null; }

// Resolve a Redfish collection { Members:[{@odata.id}] } to full member objects.
async function members(client, collection, log, label) {
  const coll = typeof collection === 'string' ? await get(client, collection).catch(() => null) : collection;
  if (!coll || !coll.Members) return [];
  const out = [];
  for (const m of coll.Members) {
    try { out.push(await get(client, oid(m))); }
    catch (e) { log?.push(`${label}: ${oid(m)} ${e.message}`); }
  }
  return out;
}

// -------- main -------------------------------------------------------------
export async function discover(host, cred, opts = {}) {
  const client = makeClient(host, cred, opts);
  const log = [];
  let root;
  try {
    root = await get(client, '/redfish/v1/');
  } catch (err) {
    return { reached: false, error: `redfish root unreachable: ${err.code || err.message}`, nodes: [], edges: [] };
  }

  const nodes = [];
  const edges = [];
  const add = (ci_type, ref, name, ids, attributes) => {
    nodes.push({ _ref: ref, ci_type, name, source: 'redfish', ids, attributes });
    return ref;
  };
  const link = (src, tgt, type) => { if (src && tgt) edges.push([src, tgt, type]); };

  // ---- top-level collections ----------------------------------------------
  const systems  = await members(client, oid(root.Systems),  log, 'systems');
  const chassis  = await members(client, oid(root.Chassis),  log, 'chassis');
  const managers = await members(client, oid(root.Managers), log, 'managers');

  const chassisByOid = new Map();  // odata.id -> {ref, key}
  const managerByOid = new Map();
  const systemByOid  = new Map();

  // ---- Chassis -------------------------------------------------------------
  for (const ch of chassis) {
    const serial = (ch.SerialNumber || ch.SKU || '').trim() || null;
    const key = serial || `${host}:chassis:${ch.Id}`;
    const ref = `chassis-${key}`;
    add('Chassis', ref, ch.Name || `Chassis ${ch.Id}`,
      { serial, mgmt_ip: host },
      attrsFrom(ch, { vendor: ch.Manufacturer || null, model: ch.Model || null, management_address: host }));
    chassisByOid.set(ch['@odata.id'], { ref, key, obj: ch });
  }

  // ---- Managers (BMC / iLO) + their Network Interfaces --------------------
  for (const mgr of managers) {
    const key = `${host}:bmc:${mgr.Id}`;
    const ref = `mgr-${key}`;
    add('Manager', ref, `${mgr.Model || mgr.ManagerType || 'BMC'} (${mgr.Id})`,
      { serial: key },
      attrsFrom(mgr, { vendor: mgr.Manufacturer || null, model: mgr.Model || null, management_address: host }));
    managerByOid.set(mgr['@odata.id'], { ref, key, obj: mgr });

    for (const nic of await members(client, oid(mgr.EthernetInterfaces), log, 'mgr-nic')) {
      const mac = nic.MACAddress || nic.PermanentMACAddress || null;
      const nref = `mgrnic-${key}-${nic.Id}`;
      add('NetworkInterface', nref, `${nic.Name || 'Mgmt NIC'} (${nic.Id})`,
        mac ? { mac: [mac] } : { serial: `${key}:nic:${nic.Id}` },
        attrsFrom(nic, { mac }));
      link(ref, nref, 'contains');
    }
  }

  // ---- Systems (Compute System) + components ------------------------------
  for (const sys of systems) {
    const serial = (sys.SerialNumber || '').trim() || null;
    const sysKey = serial || sys.UUID || `${host}:system:${sys.Id}`;
    const sref = `sys-${sysKey}`;
    add('Server', sref, sys.HostName || sys.Name || `Server ${sysKey}`,
      { serial, uuid: sys.UUID || null, mgmt_ip: host, hostname: sys.HostName || null },
      attrsFrom(sys, {
        vendor: sys.Manufacturer || null, model: sys.Model || null,
        management_address: host,
        processor_count: sys.ProcessorSummary?.Count ?? null,
        processor_model: sys.ProcessorSummary?.Model?.trim() || null,
        total_memory_gib: sys.MemorySummary?.TotalSystemMemoryGiB ?? null,
      }));
    systemByOid.set(sys['@odata.id'], { ref: sref, key: sysKey, obj: sys });

    // Chassis ▸ contains ▸ Server (via Links, else single-chassis fallback)
    const chLinks = (sys.Links?.Chassis || []).map(oid);
    if (chLinks.length) chLinks.forEach((o) => link(chassisByOid.get(o)?.ref, sref, 'contains'));
    else if (chassis.length === 1) link(chassisByOid.get(chassis[0]['@odata.id'])?.ref, sref, 'contains');

    // Server ▸ managed_by ▸ Manager
    const mgrLinks = (sys.Links?.ManagedBy || []).map(oid);
    if (mgrLinks.length) mgrLinks.forEach((o) => link(sref, managerByOid.get(o)?.ref, 'managed_by'));
    else if (managers.length === 1) link(sref, managerByOid.get(managers[0]['@odata.id'])?.ref, 'managed_by');

    // Processors
    for (const p of await members(client, oid(sys.Processors), log, 'cpu')) {
      if (p.ProcessorType && p.ProcessorType !== 'CPU') continue;
      const pref = `cpu-${sysKey}-${p.Socket || p.Id}`;
      add('Processor', pref, `${p.Model?.trim() || 'CPU'} (${p.Socket || p.Id})`,
        { serial: `${sysKey}:cpu:${p.Socket || p.Id}` },
        attrsFrom(p, { vendor: p.Manufacturer || null, model: p.Model?.trim() || null }));
      link(sref, pref, 'contains');
    }

    // Memory (DIMMs)
    for (const mm of await members(client, oid(sys.Memory), log, 'mem')) {
      if (mm.Status?.State === 'Absent' || (mm.CapacityMiB ?? 0) === 0) continue;
      const loc = mm.DeviceLocator || mm.Id;
      const mref = `mem-${sysKey}-${loc}`;
      add('Memory', mref, `DIMM ${loc} (${Math.round((mm.CapacityMiB || 0) / 1024)}GB)`,
        { serial: mm.SerialNumber?.trim() || `${sysKey}:dimm:${loc}` },
        attrsFrom(mm, { vendor: mm.Manufacturer || null, model: mm.PartNumber?.trim() || null }));
      link(sref, mref, 'contains');
    }

    // Ethernet Interfaces (system NICs, keyed by MAC so SNMP reconciles to them)
    for (const nic of await members(client, oid(sys.EthernetInterfaces), log, 'eth')) {
      const mac = nic.MACAddress || nic.PermanentMACAddress || null;
      const eref = `eth-${sysKey}-${nic.Id}`;
      add('EthernetInterface', eref, `${nic.Name || 'NIC'} (${nic.Id})`,
        mac ? { mac: [mac] } : { serial: `${sysKey}:eth:${nic.Id}` },
        attrsFrom(nic, { mac, speed_mbps: nic.SpeedMbps ?? null }));
      link(sref, eref, 'contains');
    }

    // Storage ▸ Drives & Volumes (linked directly to the Server per the hierarchy)
    for (const ctrl of await members(client, oid(sys.Storage), log, 'storage')) {
      for (const dnav of (ctrl.Drives || [])) {
        const d = await getRef(client, dnav).catch(() => null);
        if (!d) continue;
        const dref = `drv-${sysKey}-${d.Id}`;
        add('Drive', dref, `${d.Model?.trim() || 'Drive'} (${Math.round((d.CapacityBytes || 0) / 1e9)}GB)`,
          { serial: d.SerialNumber?.trim() || `${sysKey}:drive:${d.Id}` },
          attrsFrom(d, { vendor: d.Manufacturer || null, model: d.Model?.trim() || null }));
        link(sref, dref, 'contains');
      }
      for (const vol of await members(client, oid(ctrl.Volumes), log, 'volume')) {
        const vref = `vol-${sysKey}-${vol.Id}`;
        add('Volume', vref, `${vol.Name || 'Volume'} (${Math.round((vol.CapacityBytes || 0) / 1e9)}GB)`,
          { serial: vol.Identifiers?.[0]?.DurableName || `${sysKey}:vol:${vol.Id}` },
          attrsFrom(vol, { model: vol.RAIDType || vol.VolumeType || null }));
        link(sref, vref, 'contains');
      }
    }
  }

  // ---- Chassis children: NetworkAdapters, Devices, Power, Thermal ---------
  for (const { ref: chRef, key: chKey, obj: ch } of chassisByOid.values()) {
    // Network Adapters
    for (const na of await members(client, oid(ch.NetworkAdapters), log, 'netadapter')) {
      const aref = `na-${chKey}-${na.Id}`;
      add('NetworkAdapter', aref, `${na.Model?.trim() || na.Name || 'Network Adapter'}`,
        { serial: na.SerialNumber?.trim() || `${chKey}:na:${na.Id}` },
        attrsFrom(na, { vendor: na.Manufacturer || null, model: na.Model?.trim() || null }));
      link(chRef, aref, 'contains');
    }
    // Devices (PCIe) — iLO exposes PCIeDevices and/or Devices
    for (const dev of [
      ...await members(client, oid(ch.PCIeDevices), log, 'pcie'),
      ...await members(client, oid(ch.Devices), log, 'device'),
    ]) {
      const dref = `dev-${chKey}-${dev.Id}`;
      add('PCIeDevice', dref, `${dev.Name || dev.Model || 'Device'} (${dev.Id})`,
        { serial: dev.SerialNumber?.trim() || `${chKey}:dev:${dev.Id}` },
        attrsFrom(dev, { vendor: dev.Manufacturer || null, model: dev.Model?.trim() || null }));
      link(chRef, dref, 'contains');
    }
    // Power ▸ Power Supplies (inline members, no per-item GET)
    const power = await getRef(client, ch.Power).catch(() => null);
    for (const ps of (power?.PowerSupplies || [])) {
      const pref = `psu-${chKey}-${ps.MemberId ?? ps.Name}`;
      add('PowerSupply', pref, `${ps.Name || 'PSU'} ${ps.MemberId ?? ''}`.trim(),
        { serial: ps.SerialNumber?.trim() || `${chKey}:psu:${ps.MemberId ?? ps.Name}` },
        attrsFrom(ps, { vendor: ps.Manufacturer || null, model: ps.Model?.trim() || null }));
      link(chRef, pref, 'contains');
    }
    // Thermal ▸ Fans + Temperature Sensors (inline members)
    const thermal = await getRef(client, ch.Thermal).catch(() => null);
    for (const fan of (thermal?.Fans || [])) {
      const fref = `fan-${chKey}-${fan.MemberId ?? fan.Name}`;
      add('Fan', fref, `${fan.Name || fan.FanName || 'Fan'} ${fan.MemberId ?? ''}`.trim(),
        { serial: `${chKey}:fan:${fan.MemberId ?? fan.Name}` },
        attrsFrom(fan));
      link(chRef, fref, 'contains');
    }
    for (const t of (thermal?.Temperatures || [])) {
      const tref = `temp-${chKey}-${t.MemberId ?? t.Name}`;
      add('TemperatureSensor', tref, `${t.Name || 'Temp'} ${t.MemberId ?? ''}`.trim(),
        { serial: `${chKey}:temp:${t.MemberId ?? t.Name}` },
        attrsFrom(t, { reading_celsius: t.ReadingCelsius ?? null }));
      link(chRef, tref, 'contains');
    }
  }

  // ---- UpdateService ▸ Firmware & Software inventory ----------------------
  const anchor = systems.length ? systemByOid.get(systems[0]['@odata.id'])?.ref
                 : (chassis.length ? chassisByOid.get(chassis[0]['@odata.id'])?.ref : null);
  try {
    const upd = await getRef(client, root.UpdateService);
    if (upd) {
      for (const fw of await members(client, oid(upd.FirmwareInventory), log, 'firmware')) {
        const fref = `fw-${host}-${fw.Id}`;
        add('Firmware', fref, `${fw.Name || 'Firmware'} ${fw.Version || ''}`.trim(),
          { serial: `${host}:fw:${fw.Id}` },
          attrsFrom(fw, { vendor: fw.Manufacturer || null, version: fw.Version || null }));
        link(anchor, fref, 'contains');
      }
      for (const sw of await members(client, oid(upd.SoftwareInventory), log, 'software')) {
        const sref2 = `sw-${host}-${sw.Id}`;
        add('Software', sref2, `${sw.Name || 'Software'} ${sw.Version || ''}`.trim(),
          { serial: `${host}:sw:${sw.Id}` },
          attrsFrom(sw, { vendor: sw.Manufacturer || null, version: sw.Version || null }));
        link(anchor, sref2, 'contains');
      }
    }
  } catch (e) { log.push(`updateservice: ${e.message}`); }

  return {
    reached: systems.length > 0 || chassis.length > 0,
    nodes,
    edges,
    log,
    summary: `${systems.length} system(s), ${chassis.length} chassis, ${nodes.length} CI(s)`,
  };
}
