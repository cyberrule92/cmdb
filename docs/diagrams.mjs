// Technical diagrams for the solution design, authored as self-contained SVG
// (light theme for print/Word). Rendered to PNG by docs/generate.mjs.

// HPE brand typeface is "Metric"; Arial is HPE's documented digital fallback.
const FONT = "font-family='Metric, Arial, Helvetica, sans-serif'";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// HPE brand green + HPE Element secondary palette (blue, purple, teal, orange, red).
const PAL = {
  compute:  { fill: '#e6f7f1', stroke: '#01a982' }, // HPE green (brand/primary)
  network:  { fill: '#e2edf3', stroke: '#00739d' }, // HPE blue
  storage:  { fill: '#fff1e0', stroke: '#c96a00' }, // HPE orange
  mgmt:     { fill: '#ece7ef', stroke: '#614767' }, // HPE purple
  component:{ fill: '#eef1f1', stroke: '#5f7975' }, // HPE neutral
  power:    { fill: '#f9e9e9', stroke: '#a2423d' }, // HPE red
  cooling:  { fill: '#e0f4f2', stroke: '#117b82' }, // HPE teal
  sensor:   { fill: '#fbece3', stroke: '#c25b4e' }, // HPE coral
  firmware: { fill: '#ece7ef', stroke: '#614767' }, // HPE purple
  software: { fill: '#e2f3ec', stroke: '#008567' }, // HPE deep green
  proc:     { fill: '#f2f5f4', stroke: '#b4c1bf' }, // neutral process box
  accent:   { fill: '#e6f7f1', stroke: '#01a982' }, // HPE green accent
  data:     { fill: '#ece7ef', stroke: '#614767' }, // HPE purple (data store)
};
const INK = '#333333';   // HPE near-black text
const GRAY = '#666666';  // connectors / muted

function wrap(w, h, body) {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}' width='${w}' height='${h}'>
  <defs>
    <marker id='arw' markerWidth='9' markerHeight='9' refX='7' refY='3' orient='auto'>
      <path d='M0,0 L7,3 L0,6 Z' fill='#666666'/></marker>
    <marker id='arwo' markerWidth='9' markerHeight='9' refX='1' refY='3' orient='auto'>
      <path d='M7,0 L0,3 L7,6 Z' fill='#666666'/></marker>
  </defs>
  <rect width='${w}' height='${h}' fill='#ffffff'/>
  ${body}</svg>`;
}

function box(x, y, w, h, label, o = {}) {
  const p = PAL[o.cat] || PAL.accent;
  const fs = o.fs || 14;
  const sub = o.sub, sub2 = o.sub2;
  const cy = y + h / 2;
  const ty = sub2 ? cy - 12 : sub ? cy - 3 : cy + fs / 3;
  const st = (yy, t) => `<text x='${x + w / 2}' y='${yy}' text-anchor='middle' ${FONT} font-size='10.5' fill='#666666'>${esc(t)}</text>`;
  return `<rect x='${x}' y='${y}' width='${w}' height='${h}' rx='${o.r ?? 9}' fill='${o.fill || p.fill}' stroke='${o.stroke || p.stroke}' stroke-width='1.5'/>
  <text x='${x + w / 2}' y='${ty}' text-anchor='middle' ${FONT} font-size='${fs}' font-weight='600' fill='#333333'>${esc(label)}</text>
  ${sub ? st(sub2 ? cy + 5 : cy + 14, sub) : ''}
  ${sub2 ? st(cy + 21, sub2) : ''}`;
}

function label(x, y, s, o = {}) {
  return `<text x='${x}' y='${y}' text-anchor='${o.anchor || 'start'}' ${FONT} font-size='${o.fs || 12}' font-weight='${o.w || 400}' fill='${o.fill || '#555555'}'>${esc(s)}</text>`;
}
function line(x1, y1, x2, y2, o = {}) {
  return `<line x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}' stroke='${o.stroke || '#666666'}' stroke-width='${o.sw || 1.4}' ${o.dash ? "stroke-dasharray='5 4'" : ''} ${o.arrow === false ? '' : "marker-end='url(#arw)'"}/>`;
}
function title(w, t, sub) {
  return `${label(w / 2, 30, t, { anchor: 'middle', fs: 18, w: 700, fill: '#333333' })}
  ${sub ? label(w / 2, 50, sub, { anchor: 'middle', fs: 12, fill: '#666666' }) : ''}`;
}

// 1 ── System architecture (HLD) ────────────────────────────────────────────
function arch() {
  const W = 940, H = 600;
  let s = title(W, 'System Architecture (HLD)', 'Layered components — discovery to system of record');
  s += box(300, 70, 340, 46, 'Web Console (SPA)', { cat: 'accent', sub: 'Dashboard · Inventory · Topology · Discovery' });
  s += line(470, 116, 470, 150);
  s += box(210, 150, 520, 46, 'REST API — Fastify', { cat: 'accent', sub: '/cis · /jobs · /runs · /topology · /export' });
  // three pillars
  s += box(60, 240, 250, 92, 'CMDB Core', { cat: 'compute', sub: 'CI model · Reconciliation', sub2: 'Relationships · Change log' });
  s += box(350, 240, 250, 92, 'Discovery Orchestrator', { cat: 'network', sub: 'Job runner · Concurrency', sub2: 'Scheduler · Target expansion' });
  s += box(640, 240, 240, 92, 'Credential Vault', { cat: 'mgmt', sub: 'AES-256-GCM', sub2: 'secrets at rest' });
  s += line(400, 196, 210, 240); s += line(475, 196, 475, 240); s += line(560, 196, 760, 240);
  // connectors (Redfish · SNMP · vCenter · SSH)
  const conns = [['Redfish', 'iLO / BMC', 'compute'], ['SNMP', 'v2c / v3', 'network'], ['vCenter', 'ESXi / VMs', 'compute'], ['SSH', 'Linux', 'component']];
  conns.forEach((c, i) => { const x = 330 + i * 98; s += box(x, 372, 90, 44, c[0], { cat: c[2], sub: c[1], fs: 12 }); s += line(475, 332, x + 45, 372); s += line(x + 45, 416, x + 45, 470); });
  // data layer + db
  s += box(60, 372, 250, 44, 'Data Access Layer', { cat: 'proc', sub: 'repositories.js' });
  s += line(185, 332, 185, 372);
  s += `<path d='M110 470 a75 12 0 0 0 150 0 v-40 a75 12 0 0 0 -150 0 z' fill='${PAL.data.fill}' stroke='${PAL.data.stroke}' stroke-width='1.5'/>
  <ellipse cx='185' cy='430' rx='75' ry='12' fill='#fff' stroke='${PAL.data.stroke}' stroke-width='1.5'/>`;
  s += label(185, 464, 'SQLite (WAL)', { anchor: 'middle', fs: 13, w: 600, fill: '#333333' });
  s += line(185, 416, 185, 418, { arrow: false });
  // infra
  s += box(350, 470, 530, 60, 'Customer Infrastructure', { cat: 'component', sub: 'iLO BMCs (443) · Switches / Routers (SNMP 161) · Servers' });
  s += line(409, 416, 430, 470); s += line(541, 416, 560, 470);
  return wrap(W, H, s);
}

// 2 ── Discovery data flow ───────────────────────────────────────────────────
function flow() {
  const W = 1020, H = 230;
  let s = title(W, 'Discovery Data Flow', '');
  const stages = [
    ['Configure', 'credentials + job', 'mgmt'],
    ['Expand', 'IP / CIDR / range', 'proc'],
    ['Probe', 'connector per host', 'network'],
    ['Reconcile', 'identity + merge', 'compute'],
    ['Serve', 'API · UI · Excel', 'accent'],
  ];
  const bw = 168, gap = 30, y = 95, h = 66;
  let x = 40;
  stages.forEach((st, i) => {
    s += box(x, y, bw, h, st[0], { cat: st[2], sub: st[1] });
    if (i < stages.length - 1) s += line(x + bw, y + h / 2, x + bw + gap, y + h / 2);
    x += bw + gap;
  });
  s += label(W / 2, 200, 'Per-target isolation — one host failing never fails the run; results streamed to the CMDB transactionally', { anchor: 'middle', fs: 11, fill: '#666666' });
  return wrap(W, H, s);
}

// 3 ── Data model (ER) ───────────────────────────────────────────────────────
function er() {
  const W = 1000, H = 640;
  const ent = (x, y, name, rows, cat = 'proc') => {
    const w = 210, rh = 18, hh = 26, h = hh + rows.length * rh + 6;
    const p = PAL[cat];
    let b = `<rect x='${x}' y='${y}' width='${w}' height='${h}' rx='7' fill='#fff' stroke='${p.stroke}' stroke-width='1.5'/>
    <rect x='${x}' y='${y}' width='${w}' height='${hh}' rx='7' fill='${p.fill}' stroke='${p.stroke}' stroke-width='1.5'/>
    <rect x='${x}' y='${y + hh - 7}' width='${w}' height='7' fill='${p.fill}'/>
    ${label(x + 10, y + 17, name, { fs: 12.5, w: 700, fill: '#333333' })}`;
    rows.forEach((r, i) => { b += label(x + 10, y + hh + 14 + i * rh, r, { fs: 10.5, fill: r.includes('PK') ? '#333333' : '#41506a' }); });
    return { svg: b, x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  };
  let s = title(W, 'Data Model (ER)', 'Configuration items, identifiers, relationships, history');
  const cis = ent(390, 250, 'cis', ['id  PK', 'ci_type', 'name', 'recon_key  UQ', 'serial · uuid · model', 'vendor · mgmt_ip · hostname', 'status · source', 'attributes_json', 'first_seen · last_seen'], 'compute');
  const idn = ent(70, 250, 'ci_identifiers', ['id  PK', 'ci_id  FK', 'kind (mac/ip/…)', 'value', 'UQ(kind,value)'], 'network');
  const rel = ent(730, 250, 'relationships', ['id  PK', 'source_id  FK', 'target_id  FK', 'type', 'UQ(src,tgt,type)'], 'mgmt');
  const chg = ent(390, 470, 'ci_changes', ['id  PK', 'ci_id  FK', 'run_id  FK', 'field · old · new', 'changed_at'], 'sensor');
  const cred = ent(70, 70, 'credentials', ['id  PK', 'name  UQ', 'type', 'secret_blob  (sealed)'], 'storage');
  const job = ent(400, 70, 'discovery_jobs', ['id  PK', 'connector · targets', 'credential_id  FK', 'schedule_sec'], 'firmware');
  const run = ent(730, 70, 'discovery_runs', ['id  PK', 'job_id  FK', 'status · stats', 'log_json'], 'software');
  s += [cis, idn, rel, chg, cred, job, run].map((e) => e.svg).join('');
  // relations
  s += line(idn.x + idn.w, idn.y + 40, cis.x, cis.y + 40);
  s += line(rel.x, rel.y + 40, cis.x + cis.w, cis.y + 40);
  s += line(rel.x + 20, rel.y + 60, cis.x + cis.w - 10, cis.y + 90, { dash: true });
  s += line(chg.cx, chg.y, cis.cx, cis.y + cis.h);
  s += line(job.cx, job.y + job.h, cred.x + cred.w, cred.y + 40, { dash: true, arrow: true });
  s += line(run.x, run.y + 30, job.x + job.w, job.y + 30);
  s += line(job.x + job.w / 2, job.y + job.h, cis.cx - 20, cis.y, { dash: true });
  return wrap(W, H, s);
}

// 4 ── Reconciliation flow (LLD) ─────────────────────────────────────────────
function recon() {
  const W = 760, H = 780;
  const cx = W / 2;
  const node = (y, w, h, text, cat, sub) => box(cx - w / 2, y, w, h, text, { cat, sub, r: h > 60 ? 10 : 22 });
  const dia = (y, w, h, text) => {
    const p = PAL.storage;
    return `<polygon points='${cx},${y} ${cx + w / 2},${y + h / 2} ${cx},${y + h} ${cx - w / 2},${y + h / 2}' fill='${p.fill}' stroke='${p.stroke}' stroke-width='1.5'/>
    ${label(cx, y + h / 2 + 4, text, { anchor: 'middle', fs: 13, w: 600, fill: '#333333' })}`;
  };
  let s = title(W, 'Reconciliation Engine (LLD)', 'One stable identity per physical asset across sources');
  s += node(70, 320, 44, 'Incoming CI descriptor', 'accent');
  s += line(cx, 114, cx, 140);
  s += node(140, 380, 46, 'Build type-scoped recon key', 'proc', 'ci_type | serial>uuid>mac>ip>host');
  s += line(cx, 186, cx, 212);
  s += node(212, 440, 46, 'Match by identifier priority', 'proc', 'same ci_type · promoted cols then identifier table');
  s += line(cx, 258, cx, 284);
  s += dia(284, 200, 90, 'Existing CI?');
  s += label(cx - 115, 322, 'no', { anchor: 'end', fs: 12, w: 700, fill: '#a2423d' });
  s += label(cx + 115, 322, 'yes', { fs: 12, w: 700, fill: '#01a982' });
  // no branch (left)
  s += `<path d='M${cx - 100} 329 H 120 V 430' fill='none' stroke='#666666' stroke-width='1.4' marker-end='url(#arw)'/>`;
  s += box(40, 430, 160, 56, 'INSERT new CI', { cat: 'compute', sub: 'first_seen = now' });
  // yes branch (right)
  s += `<path d='M${cx + 100} 329 H 640 V 430' fill='none' stroke='#666666' stroke-width='1.4' marker-end='url(#arw)'/>`;
  s += box(560, 430, 170, 56, 'MERGE attributes', { cat: 'mgmt', sub: 'record deltas → ci_changes' });
  // join
  s += `<path d='M120 486 V 540 H ${cx}' fill='none' stroke='#666666' stroke-width='1.4'/>`;
  s += `<path d='M645 486 V 540 H ${cx}' fill='none' stroke='#666666' stroke-width='1.4'/>`;
  s += line(cx, 540, cx, 566, { arrow: true });
  s += node(566, 420, 46, 'Register all identifiers', 'network', 'future sources reconcile to this CI');
  s += line(cx, 612, cx, 638);
  s += node(638, 360, 46, 'Upsert relationships', 'accent', 'contains · managed_by · connected_to');
  s += line(cx, 684, cx, 710);
  s += node(710, 300, 44, 'Committed in one transaction', 'proc');
  return wrap(W, H, s);
}

// 5 ── Discovery sequence ────────────────────────────────────────────────────
function seq() {
  const W = 1020, H = 560;
  const actors = [['UI', 90], ['API', 250], ['Orchestrator', 430], ['Connector', 620], ['Device (iLO/SNMP)', 810], ['CMDB', 960]];
  let s = title(W, 'Discovery Sequence (LLD)', '');
  actors.forEach(([n, x]) => {
    s += box(x - 70, 60, 140, 34, n, { cat: 'accent', fs: 12 });
    s += `<line x1='${x}' y1='94' x2='${x}' y2='520' stroke='#c3ccda' stroke-width='1.2' stroke-dasharray='4 4'/>`;
  });
  const X = Object.fromEntries(actors.map(([n, x], i) => [i, x]));
  const msg = (from, to, y, text, ret = false) => {
    const x1 = X[from], x2 = X[to];
    const mid = (x1 + x2) / 2;
    return `<line x1='${x1}' y1='${y}' x2='${x2}' y2='${y}' stroke='#666666' stroke-width='1.4' ${ret ? "stroke-dasharray='5 4'" : ''} marker-end='url(#arw)'/>
    ${label(mid, y - 6, text, { anchor: 'middle', fs: 11, fill: '#555555' })}`;
  };
  let y = 130;
  s += msg(0, 1, y, 'POST /jobs/:id/run'); y += 46;
  s += msg(1, 2, y, 'runJob(id) → 202 Accepted'); y += 46;
  s += msg(2, 3, y, 'discover(host, cred) — per target, bounded pool'); y += 46;
  s += msg(3, 4, y, 'Redfish GET tree / SNMP GET+walk'); y += 46;
  s += msg(4, 3, y, 'resources', true); y += 46;
  s += msg(3, 2, y, 'normalized CI graph {nodes, edges}', true); y += 46;
  s += msg(2, 5, y, 'ingestGraph() → reconcile + upsert'); y += 46;
  s += msg(5, 2, y, 'created / updated stats', true); y += 46;
  s += msg(2, 0, y, 'run status (UI polls /runs/:id)', true);
  return wrap(W, H, s);
}

// 6 ── Redfish resource hierarchy ────────────────────────────────────────────
function redfish() {
  const W = 960, H = 620;
  let s = title(W, 'Redfish Resource Model', 'Every node becomes a first-class CI (21 from one baremetal)');
  const n = (x, y, w, t, cat, sub) => box(x, y, w, sub ? 46 : 34, t, { cat, sub, fs: 12.5 });
  const conn = (x1, y1, x2, y2) => `<path d='M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}' fill='none' stroke='#999999' stroke-width='1.3'/>`;
  // Chassis root
  s += n(390, 70, 180, 'Chassis', 'component', 'physical enclosure');
  // level 2
  const l2 = [[60, 'Compute System', 'compute', 'the server'], [300, 'Power Supplies', 'power', ''], [470, 'Fans', 'cooling', ''], [590, 'Temp Sensors', 'sensor', ''], [740, 'Network Adapters', 'network', ''], [ - 1]];
  s += n(150, 200, 170, 'Compute System', 'compute', 'ProLiant DL380');
  s += n(340, 200, 130, 'Power Supplies', 'power', '');
  s += n(486, 200, 90, 'Fans', 'cooling', '');
  s += n(592, 200, 120, 'Temp Sensors', 'sensor', '');
  s += n(728, 200, 150, 'Net Adapters', 'network', '');
  s += n(728, 264, 150, 'Devices (PCIe)', 'component', '');
  [235, 405, 531, 652, 803].forEach((x) => { s += conn(480, 116, x, 200); });
  s += conn(803, 234, 803, 264); // Net Adapters ▸ Devices (both chassis children)
  // compute system children
  const comp = [['Processors', 'component'], ['Memory', 'component'], ['Ethernet Ifaces', 'network'], ['Drives', 'storage'], ['Volumes', 'storage']];
  comp.forEach((c, i) => { const x = 40 + i * 132; s += n(x, 340, 120, c[0], c[1], ''); s += conn(235, 246, x + 60, 340); });
  // Manager branch
  s += n(150, 430, 170, 'Manager (BMC/iLO)', 'mgmt', 'managed_by');
  s += conn(235, 246, 235, 430);
  s += n(150, 500, 170, 'Network Interfaces', 'network', 'management NICs');
  s += conn(235, 476, 235, 500);
  // firmware/software
  s += n(560, 430, 150, 'Firmware', 'firmware', '');
  s += n(730, 430, 150, 'Software', 'software', '');
  s += conn(235, 246, 635, 430); s += conn(235, 246, 805, 430);
  return wrap(W, H, s);
}

// 7 ── Deployment / scale-out ────────────────────────────────────────────────
function deploy() {
  const W = 1000, H = 470;
  let s = title(W, 'Deployment Topology', 'Current single-node · roadmap collector scale-out');
  // left: single node
  s += `<rect x='40' y='70' width='430' height='360' rx='12' fill='#fafbfe' stroke='#c3ccda' stroke-width='1.4'/>`;
  s += label(255, 96, 'Single-node (current)', { anchor: 'middle', fs: 14, w: 700, fill: '#333333' });
  s += box(120, 120, 270, 44, 'OpenCMDB (Node process)', { cat: 'accent' });
  s += box(120, 180, 130, 40, 'SQLite', { cat: 'data', fs: 12 });
  s += box(260, 180, 130, 40, 'Vault key', { cat: 'mgmt', fs: 12 });
  s += line(255, 164, 190, 180); s += line(255, 164, 320, 180);
  s += box(90, 340, 330, 60, 'iLO BMCs · Switches · Servers', { cat: 'component', sub: 'reachable from this host (443 / 161)' });
  s += line(255, 220, 255, 340);
  // right: scale-out
  s += `<rect x='530' y='70' width='430' height='360' rx='12' fill='#fafbfe' stroke='#c3ccda' stroke-width='1.4'/>`;
  s += label(745, 96, 'Scale-out (roadmap)', { anchor: 'middle', fs: 14, w: 700, fill: '#333333' });
  s += box(600, 120, 290, 46, 'Central plane', { cat: 'accent', sub: 'API + Postgres/JSONB + reconciliation' });
  s += box(570, 220, 140, 44, 'Collector — Site A', { cat: 'network', fs: 11.5 });
  s += box(780, 220, 140, 44, 'Collector — Site B', { cat: 'network', fs: 11.5 });
  s += line(680, 220, 720, 166, { arrow: true }); s += line(810, 220, 780, 166, { arrow: true });
  s += label(745, 200, 'mTLS · normalized CI graphs', { anchor: 'middle', fs: 10, fill: '#666666' });
  s += box(560, 350, 160, 50, 'Site A infra', { cat: 'component', fs: 11 });
  s += box(770, 350, 160, 50, 'Site B infra', { cat: 'component', fs: 11 });
  s += line(640, 264, 640, 350); s += line(850, 264, 850, 350);
  return wrap(W, H, s);
}

export const DIAGRAMS = [
  { key: 'architecture', title: 'System Architecture (HLD)', svg: arch() },
  { key: 'dataflow', title: 'Discovery Data Flow', svg: flow() },
  { key: 'datamodel', title: 'Data Model (ER)', svg: er() },
  { key: 'reconciliation', title: 'Reconciliation Engine (LLD)', svg: recon() },
  { key: 'sequence', title: 'Discovery Sequence (LLD)', svg: seq() },
  { key: 'redfish', title: 'Redfish Resource Model', svg: redfish() },
  { key: 'deployment', title: 'Deployment Topology', svg: deploy() },
];
