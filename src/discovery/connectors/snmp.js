import snmp from 'net-snmp';
import { config } from '../../config.js';

// SNMP connector (v2c + v3). Reads the system group, ifTable/ifXTable, and the
// ENTITY-MIB physical table to classify a device and inventory its interfaces
// and chassis identity.
//
// cred (from vault):
//   v2c: { type:'snmpv2c', secret:{ community } }
//   v3 : { type:'snmpv3', username, secret:{ level, authProtocol, authKey, privProtocol, privKey } }

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysContact: '1.3.6.1.2.1.1.4.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
  sysServices: '1.3.6.1.2.1.1.7.0',
  ifTable: '1.3.6.1.2.1.2.2.1',
  ifXTable: '1.3.6.1.2.1.31.1.1.1',
  entPhysical: '1.3.6.1.2.1.47.1.1.1.1',
  lldpRem: '1.0.8802.1.1.2.1.4.1.1', // LLDP-MIB lldpRemTable
};

function toStr(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString('utf8').replace(/\0/g, '').trim();
  return String(v).trim();
}
function toMac(v) {
  if (!Buffer.isBuffer(v) || v.length !== 6) return null;
  return [...v].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

function buildSession(host, cred, opts) {
  const port = opts.port || 161;
  const options = {
    port,
    retries: 1,
    timeout: config.discovery.connectTimeoutMs,
    transport: 'udp4',
  };
  if (cred.type === 'snmpv3') {
    options.version = snmp.Version3;
    const s = cred.secret || {};
    const levelMap = {
      noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
      authNoPriv: snmp.SecurityLevel.authNoPriv,
      authPriv: snmp.SecurityLevel.authPriv,
    };
    const user = {
      name: cred.username,
      level: levelMap[s.level] || snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols[s.authProtocol || 'sha'],
      authKey: s.authKey,
      privProtocol: snmp.PrivProtocols[s.privProtocol || 'aes'],
      privKey: s.privKey,
    };
    return snmp.createV3Session(host, user, options);
  }
  options.version = snmp.Version2c;
  const community = (cred.secret && cred.secret.community) || 'public';
  return snmp.createSession(host, community, options);
}

function getScalars(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => {
      if (err) return reject(err);
      const out = {};
      varbinds.forEach((vb, i) => {
        out[oids[i]] = snmp.isVarbindError(vb) ? null : vb.value;
      });
      resolve(out);
    });
  });
}

function getTable(session, baseOid, columns) {
  return new Promise((resolve) => {
    session.tableColumns(baseOid, columns, 20, (err, table) => {
      if (err) return resolve({}); // table may be unsupported; degrade gracefully
      resolve(table || {});
    });
  });
}

const NET_HINTS = /(cisco|ios|nx-os|juniper|junos|arista|aruba|procurve|fortinet|fortigate|palo\s?alto|mikrotik|routeros|huawei|brocade|force10|extreme|ubiquiti|edgeos|switch|router|firewall)/i;
const SRV_HINTS = /(linux|windows|net-snmp|ucd-snmp|freebsd|solaris|server|xenserver)/i;
const HV_HINTS  = /(vmware|esxi|proxmox|hyper-v|kvm)/i;

function classify(sysDescr, sysServices) {
  const d = (sysDescr || '').toLowerCase();
  if (HV_HINTS.test(d)) return 'Hypervisor';
  if (NET_HINTS.test(d)) return 'NetworkDevice';
  if (SRV_HINTS.test(d)) return 'Server';
  // Fall back to sysServices bitmask: L2 (bit2) set ⇒ network gear.
  const svc = Number(sysServices) || 0;
  if (svc & 0x02) return 'NetworkDevice';
  return 'Server';
}

const IF_ADMIN = { 1: 'up', 2: 'down', 3: 'testing' };
const IF_OPER = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };

export async function discover(host, cred, opts = {}) {
  const session = buildSession(host, cred, opts);
  const log = [];
  try {
    let sys;
    try {
      sys = await getScalars(session, [
        OID.sysDescr, OID.sysObjectID, OID.sysUpTime, OID.sysContact,
        OID.sysName, OID.sysLocation, OID.sysServices,
      ]);
    } catch (err) {
      return { reached: false, error: `snmp no response: ${err.message}`, nodes: [], edges: [] };
    }
    const sysDescr = toStr(sys[OID.sysDescr]);
    if (!sysDescr && sys[OID.sysName] == null) {
      return { reached: false, error: 'snmp: empty system group (wrong community?)', nodes: [], edges: [] };
    }

    const sysName = toStr(sys[OID.sysName]);
    const sysServices = sys[OID.sysServices];
    const ci_type = classify(sysDescr, sysServices);

    // ENTITY-MIB chassis identity (serial/model/vendor) when available.
    const ent = await getTable(session, OID.entPhysical, [5, 7, 11, 12, 13]);
    let serial = null, model = null, vendor = null;
    for (const idx of Object.keys(ent)) {
      const row = ent[idx];
      if (Number(row[5]) === 3 /* chassis */ && toStr(row[11])) {
        serial = toStr(row[11]);
        model = toStr(row[13]) || model;
        vendor = toStr(row[12]) || vendor;
        break;
      }
    }

    const deviceKey = serial || sysName || host;
    const dref = `dev-${deviceKey}`;
    const nodes = [];
    const edges = [];

    // Interfaces ------------------------------------------------------------
    const ift = await getTable(session, OID.ifTable, [1, 2, 3, 5, 6, 7, 8]);
    const ifx = await getTable(session, OID.ifXTable, [1, 15, 18]);
    let ifCount = 0;
    for (const idx of Object.keys(ift)) {
      const r = ift[idx];
      const x = ifx[idx] || {};
      const ifType = Number(r[3]);
      if (ifType === 24) continue; // skip softwareLoopback
      ifCount++;
      const mac = toMac(r[6]);
      const name = toStr(x[1]) || toStr(r[2]) || `if${idx}`;
      const highSpeed = Number(x[15]);
      const speedMbps = highSpeed > 0 ? highSpeed : Math.round((Number(r[5]) || 0) / 1e6);
      const iref = `if-${deviceKey}-${idx}`;
      nodes.push({
        _ref: iref,
        ci_type: 'NetworkInterface',
        name: `${name} @ ${sysName || host}`,
        source: 'snmp',
        ids: mac ? { mac: [mac] } : { serial: `${deviceKey}:if:${idx}` },
        attributes: {
          if_index: Number(idx),
          descr: toStr(r[2]),
          alias: toStr(x[18]) || null,
          mac,
          if_type: ifType,
          speed_mbps: speedMbps || null,
          admin_status: IF_ADMIN[Number(r[7])] || null,
          oper_status: IF_OPER[Number(r[8])] || null,
        },
      });
      edges.push([dref, iref, 'contains']);
    }

    // LLDP neighbours → connected_to topology (L2). Columns: 7 remPortId, 9 remSysName.
    let lldpCount = 0;
    const seenNbr = new Set();
    const lldp = await getTable(session, OID.lldpRem, [7, 9]);
    for (const idx of Object.keys(lldp)) {
      const remName = toStr(lldp[idx][9]);
      if (!remName || seenNbr.has(remName)) continue;
      seenNbr.add(remName);
      lldpCount++;
      const nref = `nbr-${remName}`;
      nodes.push({
        _ref: nref, ci_type: 'NetworkDevice', name: remName, source: 'snmp-lldp',
        ids: { hostname: remName },
        attributes: { discovered_via: 'lldp', neighbour_of: sysName || host },
      });
      edges.push([dref, nref, 'connected_to']);
    }

    nodes.unshift({
      _ref: dref,
      ci_type,
      name: sysName || host,
      source: 'snmp',
      ids: {
        serial,
        hostname: sysName,
        mgmt_ip: host,
      },
      attributes: {
        sys_descr: sysDescr,
        sys_object_id: toStr(sys[OID.sysObjectID]),
        vendor,
        model,
        contact: toStr(sys[OID.sysContact]) || null,
        location: toStr(sys[OID.sysLocation]) || null,
        uptime_ticks: Number(sys[OID.sysUpTime]) || null,
        sys_services: Number(sysServices) || null,
        interface_count: ifCount,
        lldp_neighbours: lldpCount,
        management_address: host,
      },
    });

    return {
      reached: true,
      nodes,
      edges,
      log,
      summary: `${ci_type} ${sysName || host}, ${ifCount} interface(s), ${lldpCount} LLDP neighbour(s)`,
    };
  } finally {
    try { session.close(); } catch { /* noop */ }
  }
}
