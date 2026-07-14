import { Client } from 'ssh2';
import { config } from '../../config.js';

// SSH connector for Linux/Unix baremetal & VMs. Runs a fixed set of read-only
// commands and builds a Server/Hypervisor CI plus Processor summary, Drive,
// NetworkInterface and Filesystem CIs. All parsing is done by the pure
// functions below (unit-tested in test/ssh.test.mjs).
//
// cred (from vault): { username, secret:{ password | privateKey } }
// opts: { port=22 }

// ---- pure parsers -----------------------------------------------------------
export function parseOsRelease(t) {
  const kv = {};
  for (const m of String(t).matchAll(/^([A-Z_]+)=("?)(.*?)\2$/gm)) kv[m[1]] = m[3];
  return { os_name: kv.NAME || null, os_version: kv.VERSION || kv.VERSION_ID || null, os_id: kv.ID || null };
}
export function parseCpuinfo(t) {
  const models = [...String(t).matchAll(/^model name\s*:\s*(.+)$/gm)].map((m) => m[1].trim());
  return { cpu_model: models[0] || null, cpu_logical: models.length || null };
}
export function parseMeminfo(t) {
  const m = /^MemTotal:\s+(\d+)\s*kB/m.exec(String(t));
  return { mem_total_gib: m ? +(Number(m[1]) / 1024 / 1024).toFixed(1) : null };
}
export function parseLsblk(t) {
  // expects: NAME SIZE TYPE MODEL SERIAL  (-dn -o ...)
  const out = [];
  for (const ln of String(t).trim().split('\n')) {
    if (!ln.trim()) continue;
    const p = ln.trim().split(/\s{2,}|\t/).filter(Boolean);
    const [name, size, type, ...rest] = ln.trim().split(/\s+/);
    if (type && type !== 'disk') continue;
    out.push({ name, size, model: rest.slice(0, -1).join(' ') || null, serial: rest.length ? rest[rest.length - 1] : null });
  }
  return out;
}
export function parseIp(linkText, addrText) {
  const nics = {};
  for (const m of String(linkText).matchAll(/^\d+:\s+([^:@]+)[^\n]*?link\/\w+\s+([0-9a-f:]{17})/gim)) {
    const name = m[1].trim();
    if (name === 'lo') continue;
    nics[name] = { name, mac: m[2].toLowerCase(), ipv4: [] };
  }
  for (const m of String(addrText || '').matchAll(/^\d+:\s+(\S+)\s+inet\s+([\d.]+)\/\d+/gim)) {
    const name = m[1].replace(/@.*/, '');
    if (nics[name]) nics[name].ipv4.push(m[2]);
  }
  return Object.values(nics);
}
export function parseDf(t) {
  const out = [];
  const lines = String(t).trim().split('\n').slice(1); // skip header
  for (const ln of lines) {
    const p = ln.trim().split(/\s+/);
    if (p.length < 7) continue;
    const [fs, type, size, used, avail, pct, ...mnt] = p;
    if (/tmpfs|devtmpfs|overlay|squashfs/.test(type)) continue;
    out.push({ device: fs, fstype: type, size, used, use_pct: pct, mount: mnt.join(' ') });
  }
  return out;
}
export function classifyOs(osName) {
  return /esxi|vmware/i.test(osName || '') ? 'Hypervisor' : 'Server';
}

// ---- SSH transport ----------------------------------------------------------
function connect(host, cred, opts) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const cfg = {
      host, port: opts.port || 22, username: cred.username,
      readyTimeout: config.discovery.connectTimeoutMs,
    };
    if (cred.secret?.privateKey) cfg.privateKey = cred.secret.privateKey;
    else cfg.password = cred.secret?.password;
    conn.on('ready', () => resolve(conn)).on('error', reject).connect(cfg);
  });
}
function run(conn, cmd) {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve('');
      let out = '';
      stream.on('data', (d) => { out += d; }).stderr.on('data', () => {});
      stream.on('close', () => resolve(out));
    });
  });
}

// ---- connector --------------------------------------------------------------
export async function discover(host, cred, opts = {}) {
  let conn;
  try {
    conn = await connect(host, cred, opts);
  } catch (err) {
    return { reached: false, error: `ssh: ${err.level || err.code || err.message}`, nodes: [], edges: [] };
  }
  try {
    const [hostname, osr, cpu, mem, disks, link, addr, df, dmi] = await Promise.all([
      run(conn, 'hostname -f 2>/dev/null || hostname'),
      run(conn, 'cat /etc/os-release 2>/dev/null'),
      run(conn, 'cat /proc/cpuinfo 2>/dev/null'),
      run(conn, 'cat /proc/meminfo 2>/dev/null'),
      run(conn, 'lsblk -dn -o NAME,SIZE,TYPE,MODEL,SERIAL 2>/dev/null'),
      run(conn, 'ip -o link 2>/dev/null'),
      run(conn, 'ip -o -4 addr 2>/dev/null'),
      run(conn, 'df -PT 2>/dev/null'),
      run(conn, 'cat /sys/class/dmi/id/product_serial /sys/class/dmi/id/product_uuid /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name 2>/dev/null'),
    ]);

    const os = parseOsRelease(osr);
    const ci_type = classifyOs(os.os_name);
    const nics = parseIp(link, addr);
    const [serial, uuid, vendor, model] = dmi.trim().split('\n').map((s) => (s || '').trim());
    const fqdn = hostname.trim() || host;
    const sysKey = serial || uuid || fqdn;
    const sref = `ssh-${sysKey}`;

    const nodes = [], edges = [];
    nodes.push({
      _ref: sref, ci_type, name: fqdn, source: 'ssh',
      ids: { serial: serial || null, uuid: uuid || null, mgmt_ip: host, hostname: fqdn },
      attributes: {
        vendor: vendor || null, model: model || null,
        ...os, ...parseCpuinfo(cpu), ...parseMeminfo(mem),
        filesystems: parseDf(df), management_address: host,
      },
    });

    for (const d of parseLsblk(disks)) {
      const ref = `ssh-drv-${sysKey}-${d.name}`;
      nodes.push({ _ref: ref, ci_type: 'Drive', name: `${d.name} (${d.size || '?'})`, source: 'ssh',
        ids: { serial: d.serial && d.serial !== '' ? d.serial : `${sysKey}:disk:${d.name}` },
        attributes: { device: d.name, size: d.size, model: d.model } });
      edges.push([sref, ref, 'contains']);
    }
    for (const n of nics) {
      const ref = `ssh-nic-${sysKey}-${n.name}`;
      nodes.push({ _ref: ref, ci_type: 'NetworkInterface', name: `${n.name} @ ${fqdn}`, source: 'ssh',
        ids: n.mac ? { mac: [n.mac] } : { serial: `${sysKey}:nic:${n.name}` },
        attributes: { name: n.name, mac: n.mac, ipv4: n.ipv4 } });
      edges.push([sref, ref, 'contains']);
    }

    return { reached: true, nodes, edges, summary: `${ci_type} ${fqdn}, ${nics.length} NIC(s), ${parseLsblk(disks).length} disk(s)` };
  } finally {
    try { conn.end(); } catch { /* noop */ }
  }
}
