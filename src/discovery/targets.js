// Expand a target spec into a list of IPv4 addresses.
// Accepts newline/comma separated entries of:
//   - single IP            192.168.1.10
//   - CIDR                 10.0.0.0/24
//   - hyphen range         10.0.0.5-10.0.0.40  (or 10.0.0.5-40)
//   - hostname             ilo-node1.dc.local  (passed through as-is)

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function expandEntry(entry) {
  const e = entry.trim();
  if (!e) return [];

  // CIDR
  if (e.includes('/')) {
    const [base, bitsRaw] = e.split('/');
    const bits = Number(bitsRaw);
    const baseInt = ipToInt(base);
    if (baseInt == null || bits < 0 || bits > 32) return [];
    const size = 2 ** (32 - bits);
    const network = baseInt & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0);
    const out = [];
    // Skip network & broadcast for /31 or larger blocks.
    const start = size > 2 ? network + 1 : network;
    const end = size > 2 ? network + size - 1 : network + size;
    for (let i = start; i < end; i++) out.push(intToIp(i));
    return out;
  }

  // Range a-b
  if (e.includes('-')) {
    const [a, b] = e.split('-').map((s) => s.trim());
    const aInt = ipToInt(a);
    let bInt;
    if (b.includes('.')) bInt = ipToInt(b);
    else if (aInt != null) bInt = (aInt & ~255) + Number(b); // last-octet shorthand
    if (aInt == null || bInt == null || bInt < aInt) return [];
    const out = [];
    for (let i = aInt; i <= bInt; i++) out.push(intToIp(i));
    return out;
  }

  // Single IP or hostname
  return [e];
}

export function expandTargets(spec, max = 65536) {
  const entries = String(spec || '').split(/[\n,]+/);
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    for (const ip of expandEntry(entry)) {
      if (seen.has(ip)) continue;
      seen.add(ip);
      out.push(ip);
      if (out.length >= max) return out;
    }
  }
  return out;
}
