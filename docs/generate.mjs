// Generates docs/OpenCMDB-Solution-Design.docx (HLD + LLD + diagrams) and
// writes the PNG/SVG diagrams to docs/diagrams/. Run: `npm run docs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, PageBreak,
} from 'docx';
import { DIAGRAMS } from './diagrams.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIA_DIR = path.join(__dirname, 'diagrams');
fs.mkdirSync(DIA_DIR, { recursive: true });

// ---- render diagrams to PNG (and keep the SVG source) ----
const IMG = {};
for (const d of DIAGRAMS) {
  fs.writeFileSync(path.join(DIA_DIR, `${d.key}.svg`), d.svg);
  const r = new Resvg(d.svg, { fitTo: { mode: 'width', value: 1600 }, font: { loadSystemFonts: true } });
  const png = r.render();
  const buf = png.asPng();
  fs.writeFileSync(path.join(DIA_DIR, `${d.key}.png`), buf);
  IMG[d.key] = { buf, w: png.width, h: png.height };
}

// ---- docx helpers (HPE branding) ----
const BRAND = '01A982';  // HPE green
const HEAD = '333333';   // HPE near-black headings
const MUTED = '767676';  // HPE gray
const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 260, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: BRAND, space: 4 } }, children: [new TextRun({ text: t, color: HEAD })] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 180, after: 80 }, children: [new TextRun({ text: t, color: BRAND })] });
const h3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 120, after: 60 }, children: [new TextRun({ text: t })] });
const p = (t, o = {}) => new Paragraph({ spacing: { after: 100 }, alignment: o.align, children: Array.isArray(t) ? t : [new TextRun({ text: t, italics: o.italics, bold: o.bold, color: o.color, size: o.size })] });
const bullet = (t) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: Array.isArray(t) ? t : [new TextRun({ text: t })] });
const run = (text, o = {}) => new TextRun({ text, ...o });
const code = (t) => new Paragraph({
  spacing: { after: 100 }, shading: { fill: 'F2F4F8' },
  children: t.split('\n').map((ln, i) => new TextRun({ text: ln, font: 'Consolas', size: 17, break: i ? 1 : 0 })),
});

function img(key, maxW = 620) {
  const { buf, w, h } = IMG[key];
  const width = Math.min(maxW, w);
  const height = Math.round(h * (width / w));
  return new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 60, after: 40 },
    children: [new ImageRun({ data: buf, type: 'png', transformation: { width, height } })],
  });
}
const caption = (t) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: t, italics: true, size: 17, color: MUTED })] });

const cell = (text, o = {}) => new TableCell({
  width: o.width ? { size: o.width, type: WidthType.PERCENTAGE } : undefined,
  shading: o.head ? { fill: BRAND } : (o.zebra ? { fill: 'F5F7FA' } : undefined),
  margins: { top: 40, bottom: 40, left: 90, right: 90 },
  children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: o.head, color: o.head ? 'FFFFFF' : undefined, size: 18 })] })],
});
function table(headers, rows, widths) {
  const border = { style: BorderStyle.SINGLE, size: 2, color: 'D5DCE6' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((hd, i) => cell(hd, { head: true, width: widths?.[i] })) }),
      ...rows.map((r, ri) => new TableRow({ children: r.map((c, i) => cell(c, { width: widths?.[i], zebra: ri % 2 === 1 })) })),
    ],
  });
}
const spacer = () => new Paragraph({ spacing: { after: 120 }, children: [] });

// ---- content ----
const children = [];
const D = new Date().toISOString().slice(0, 10);

// Cover
children.push(
  new Paragraph({ spacing: { before: 1600, after: 0 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'OpenCMDB', bold: true, size: 72, color: BRAND })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: 'Solution Design Document', size: 36, color: MUTED })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 }, children: [new TextRun({ text: 'Enterprise Hardware Asset Discovery & CMDB', size: 24 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'High-Level Design (HLD) · Low-Level Design (LLD) · Technical Diagrams', size: 22, italics: true, color: MUTED })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 1200 }, children: [new TextRun({ text: `Version 1.0    ·    ${D}`, size: 22 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Baremetal · Hypervisors · VMs · Storage · Network', size: 20, color: MUTED })] }),
  new Paragraph({ children: [new PageBreak()] }),
);

// 1. Executive summary
children.push(h1('1. Executive Summary'));
children.push(p('OpenCMDB is an enterprise-grade platform that discovers, normalizes, and manages a complete hardware asset inventory across baremetal servers, hypervisors, virtual machines, storage, and network devices. It combines the two disciplines that commercial tools such as OpenText uCMDB and HPE OpsRamp address separately: agentless multi-protocol discovery and a reconciled system of record (CMDB).'));
children.push(p('Discovery is performed agentlessly over the Redfish API (HPE iLO / DMTF BMCs) for deep baremetal hardware inventory, and over SNMP (v2c/v3) for network devices and servers. Every discovered resource becomes a first-class Configuration Item (CI) with a full attribute set and typed relationships. A reconciliation engine guarantees one stable identity per physical asset across sources and repeated scans. The platform exposes a REST API, a web console (inventory, resource hierarchy, dependency topology), and an Excel inventory export.'));
children.push(p('This document presents the High-Level Design (system architecture, data flow, deployment) and the Low-Level Design (data model, reconciliation algorithm, connector design, discovery sequence, API), supported by technical diagrams.'));

// 2. Objectives & scope
children.push(h1('2. Objectives & Scope'));
children.push(h3('In scope'));
[
  'Agentless discovery via Redfish (baremetal), SNMP (network/servers, +LLDP L2 topology), vCenter/ESXi (hypervisors + VMs + datastores), and SSH (Linux/Unix).',
  'CMDB core: typed CIs, directed relationships, reconciliation, change history, manual merge.',
  'Encrypted credential vault (AES-256-GCM at rest); API tokens + RBAC + audit trail (opt-in).',
  'CI lifecycle (stale → decommissioned) and Prometheus metrics.',
  'Web console: dashboard, searchable inventory, CI detail, resource hierarchy, dependency topology, access & audit.',
  'Bulk inventory reports: filter-aware Excel and CSV.',
].forEach((t) => children.push(bullet(t)));
children.push(h3('Out of scope'));
[
  'Monitoring / alerting / AIOps; agent-based collection; multi-tenancy.',
  'Connectors not yet built: WMI/WinRM (Windows), cloud (AWS/Azure/GCP), storage arrays.',
  'Postgres backend, collector appliances, and OIDC federation (designed for; see §9).',
].forEach((t) => children.push(bullet(t)));

// 3. Reference product analysis
children.push(h1('3. Reference Product Analysis'));
children.push(p('OpenCMDB targets the intersection of the two reference products: discover → normalize → manage a hardware asset inventory.'));
children.push(table(
  ['Capability', 'OpenText uCMDB', 'HPE OpsRamp', 'OpenCMDB'],
  [
    ['Primary role', 'System of record (CMDB)', 'Hybrid IT ops & monitoring', 'Discovery + CMDB inventory'],
    ['CI type model', 'Rich CIT hierarchy', 'Resource-type based', 'Typed CI catalog'],
    ['Discovery', 'Universal Discovery (agent + agentless)', 'Agent + agentless gateway', 'Agentless: Redfish, SNMP, vCenter, SSH'],
    ['Reconciliation', 'Identification rules', 'Resource de-dup', 'Type-scoped identifier-priority engine'],
    ['Topology', 'Graph + impact analysis', 'Service maps', 'Directed relationship graph + views'],
    ['Deployment', 'Server + Data Flow Probes', 'SaaS + collector appliances', 'Single node; collector model on roadmap'],
  ],
  [22, 26, 26, 26],
));
children.push(spacer());
children.push(p('Design stance: keep the core (CI model, reconciliation, relationships, API) small and correct; make discovery a pluggable connector interface so new protocols are additive.'));

// 4. HLD
children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(h1('4. High-Level Design (HLD)'));
children.push(h2('4.1 System Architecture'));
children.push(img('architecture'));
children.push(caption('Figure 1 — Layered system architecture'));
children.push(p('The platform is organized in layers:'));
[
  ['Web Console (SPA):', ' dashboard, inventory browser, CI detail, resource hierarchy tree, and dependency topology graph — no build step, served statically.'],
  ['REST API (Fastify):', ' a thin, fast HTTP layer exposing CIs, jobs, runs, topology, and export endpoints.'],
  ['CMDB Core:', ' the CI type model, the reconciliation engine, relationships, and change history.'],
  ['Discovery Orchestrator:', ' expands targets, runs connectors in a bounded worker pool, and schedules recurring jobs.'],
  ['Credential Vault:', ' AES-256-GCM sealing of protocol secrets; secrets never leave the server.'],
  ['Data Access Layer / SQLite:', ' all persistence behind a repository abstraction (portable to Postgres).'],
].forEach(([b, t]) => children.push(bullet([run(b, { bold: true }), run(t)])));

children.push(h2('4.2 Discovery Data Flow'));
children.push(img('dataflow', 640));
children.push(caption('Figure 2 — End-to-end discovery pipeline'));
[
  'Configure — operator stores protocol credentials and defines a discovery job (connector + targets + credential).',
  'Expand — the orchestrator expands the target spec (IP / CIDR / range) into a host list.',
  'Probe — a bounded worker pool runs the connector against each host, returning a normalized CI graph {nodes, edges}.',
  'Reconcile & Ingest — each node resolves to a new or existing CI; attributes merge, deltas are logged, relationships upsert — transactionally.',
  'Serve — CIs, relationships, history, topology, and the Excel report are exposed via REST and the console.',
].forEach((t, i) => children.push(bullet([run(`${i + 1}. `, { bold: true }), run(t)])));

children.push(h2('4.3 Technology Stack'));
children.push(table(
  ['Concern', 'Choice', 'Rationale'],
  [
    ['Runtime', 'Node.js 20+ (ESM)', 'Async I/O fits fan-out network discovery; one language across API + UI'],
    ['API', 'Fastify', 'Lightweight, fast, schema-friendly'],
    ['Datastore', 'SQLite (WAL) / better-sqlite3', 'Zero-ops embedded DB; synchronous, transactional reconciliation; abstracted for Postgres'],
    ['Redfish', 'axios + Node https', 'Self-signed-cert handling for BMCs'],
    ['SNMP', 'net-snmp (pure JS)', 'v2c + v3, no native dependencies'],
    ['Concurrency', 'p-limit', 'Bounded parallel probing'],
    ['Vault', 'node:crypto AES-256-GCM', 'Authenticated encryption without an external KMS dependency (v1)'],
    ['Excel export', 'exceljs', 'Multi-sheet .xlsx inventory report'],
  ],
  [16, 26, 58],
));

children.push(h2('4.4 Deployment Topology'));
children.push(img('deployment', 640));
children.push(caption('Figure 3 — Current single-node deployment and roadmap collector scale-out'));
children.push(p('v1 runs as a single Node process with embedded SQLite, deployed wherever it can reach the discovery targets (a lab, a data-center pod, or an appliance). The scale-out target mirrors the OpsRamp collector model: a central plane (API + Postgres + reconciliation) with per-site collectors that run connectors locally and stream normalized CI graphs upstream over mTLS. The data-access abstraction and stable connector contract make this migration additive.'));

// 5. LLD
children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(h1('5. Low-Level Design (LLD)'));
children.push(h2('5.1 Data Model'));
children.push(img('datamodel'));
children.push(caption('Figure 4 — Entity-relationship model'));
children.push(p('Hot identity/query fields are promoted to indexed columns on the cis table; the long tail of attributes lives in attributes_json (portable to Postgres JSONB). Key entities:'));
[
  ['cis', 'Configuration Items. recon_key is the unique, deterministic identity key. serial/uuid/model/vendor/mgmt_ip/hostname are promoted for indexed lookup and UI filters.'],
  ['ci_identifiers', 'Alternate identity keys (mac, ip, fqdn, serial, uuid, asset_tag) that let future sources reconcile to an existing CI.'],
  ['relationships', 'Directed edges (contains, managed_by, runs_on, connected_to, member_of) forming the topology graph.'],
  ['ci_changes', 'Per-run attribute deltas — the change history.'],
  ['credentials / discovery_jobs / discovery_runs', 'The credential vault and Data-Flow-Management equivalents (job definitions and run results).'],
].forEach(([b, t]) => children.push(bullet([run(`${b} — `, { bold: true }), run(t)])));

children.push(h2('5.2 Reconciliation Engine'));
children.push(img('reconciliation', 470));
children.push(caption('Figure 5 — Reconciliation control flow'));
children.push(p('The reconciliation engine collapses observations from multiple sources and repeated scans into one authoritative CI per physical asset. Identity keys are type-scoped (prefixed with ci_type) and chosen by identifier strength:'));
children.push(code('{ci_type} | serial > uuid > mac(normalized) > mgmt_ip > hostname > synthetic'));
children.push(p('Matching proceeds in priority order, restricted to the same CI type, checking promoted columns first (indexed) then the identifier table. On a match, attributes are merged and changed promoted fields are written to ci_changes; otherwise a new CI is inserted. All incoming identifiers are then registered so any future source sharing an identifier reconciles to this CI. The entire ingest of one host runs in a single SQLite transaction.'));
children.push(h3('Correctness safeguards'));
[
  'Type-scoping prevents a Chassis, Server, and Manager (which all share one BMC management IP) from collapsing into one CI, and prevents a NIC and its host from merging on a shared MAC.',
  'MACs are normalized before comparison; child-component synthetic serials are parent-scoped for global uniqueness.',
  'A Redfish-discovered server (known by serial) and the same host later seen by SNMP (known by MAC) become one CI — validated by automated tests.',
].forEach((t) => children.push(bullet(t)));

children.push(h2('5.3 Discovery Connectors'));
children.push(p('A connector implements a single contract, so adding a protocol is one file plus registration — no core changes:'));
children.push(code(`async function discover(host, credential, opts)
  -> { reached, nodes:[CIDescriptor], edges:[[srcRef, tgtRef, relType]], error?, summary? }

CIDescriptor = { _ref, ci_type, name, source,
                 ids:{ serial, uuid, mac[], mgmt_ip, hostname, asset_tag },
                 attributes:{ ... } }`));
children.push(h3('Redfish / iLO'));
children.push(p('Walks the full DMTF Redfish tree over HTTPS (Basic auth, self-signed tolerated), emitting a first-class CI for every node: Chassis, Compute System, Manager (BMC), Processors, Memory, Ethernet Interfaces, Drives, Volumes, Network Adapters, PCIe Devices, Power Supplies, Fans, Temperature Sensors, Manager Network Interfaces, and Firmware/Software inventory. Every resource’s complete attribute set is preserved. One baremetal yields 21 CIs (see Section 6).'));
children.push(h3('SNMP'));
children.push(p('Supports v2c and v3 (auth/priv). Reads the system group (identity + classification into NetworkDevice / Server / Hypervisor), ifTable/ifXTable (interface CIs with MAC, speed, status), the ENTITY-MIB physical table (chassis serial/model/vendor), and the LLDP-MIB neighbour table to create connected_to (L2 topology) edges between devices.'));
children.push(h3('vCenter / ESXi'));
children.push(p('Uses the vSphere Automation REST API (vCenter 7+ /api with 6.5+ /rest fallback). Produces Cluster, Hypervisor (host), VM, and Datastore CIs with cluster▸host containment, VM runs_on host, and host↔datastore relationships, including CPU/memory/power-state attributes.'));
children.push(h3('SSH / Linux'));
children.push(p('Connects over SSH (password or private key) and runs read-only commands (os-release, /proc/cpuinfo, /proc/meminfo, lsblk, ip, df, DMI) to build a Server/Hypervisor CI plus Drive, NetworkInterface, and filesystem inventory. All output parsing is done by pure, unit-tested functions. Host NICs are modelled as NetworkInterface CIs so they reconcile with SNMP-discovered interfaces by MAC.'));

children.push(h2('5.4 Discovery Sequence'));
children.push(img('sequence', 640));
children.push(caption('Figure 6 — Runtime sequence of a discovery run'));

children.push(h2('5.5 REST API'));
children.push(table(
  ['Method & Path', 'Purpose'],
  [
    ['GET /api/stats', 'Totals by type + recent runs'],
    ['GET /api/cis?type&q&status', 'Filtered inventory'],
    ['GET /api/cis/:id', 'CI + attributes + relationships + change history'],
    ['GET /api/cis/:id/tree?depth&scope', 'Resource hierarchy (depth-limited; scope=machine)'],
    ['GET /api/topology?depth', 'Dependency graph nodes + edges'],
    ['GET /api/export/inventory.xlsx?type&q', 'Filter-aware Excel report'],
    ['POST /api/jobs/:id/run', 'Trigger a discovery run (202; UI polls /runs/:id)'],
    ['GET/POST/DELETE /api/credentials|jobs', 'Vault & job management (secrets never returned)'],
  ],
  [46, 54],
));

// 6. Redfish model
children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(h1('6. Redfish Resource Model'));
children.push(img('redfish'));
children.push(caption('Figure 7 — Redfish hierarchy mapped to first-class CIs'));
children.push(p('Each node in the Redfish tree is modelled as its own CI with containment/management relationships, so the console renders the exact resource hierarchy and the topology graph. A single baremetal server typically produces 21 CIs, and re-discovery is idempotent (no duplicates).'));

// 7. Security
children.push(h1('7. Security Design'));
[
  ['Credentials at rest:', ' AES-256-GCM (format v1:iv:tag:ciphertext); key from CMDB_SECRET_KEY (inject via secret manager) or a 0600 keyfile. secret_blob is never returned by the API.'],
  ['Authentication & RBAC (implemented, opt-in):', ' bearer API tokens with roles viewer < operator < admin, enforced when CMDB_AUTH=1. GET requires viewer; mutations require operator; credential/token/merge/lifecycle operations require admin. Disabled by default so trusted-network deployments need no change.'],
  ['Audit trail (implemented):', ' every mutating action (job.run, credential.create, ci.merge, token.create, lifecycle.sweep, …) is recorded with actor, target, and timestamp, and surfaced in the console.'],
  ['Transport:', ' HTTPS for Redfish/vCenter; SNMP v3 auth/priv where available; v2c community strings supported but flagged low-assurance.'],
  ['Injection safety:', ' all database access uses parameterized prepared statements.'],
  ['Hardening roadmap:', ' OIDC/JWT federation, TLS termination, KMS integration, and network segmentation for probes.'],
].forEach(([b, t]) => children.push(bullet([run(b, { bold: true }), run(t)])));

// 8. Testing
children.push(h1('8. Testing & Validation'));
children.push(table(
  ['Test suite', 'Coverage', 'Result'],
  [
    ['recon', 'Reconciliation: insert, idempotent re-ingest, cross-source MAC merge, change tracking, no false merges', '8/8'],
    ['redfish', 'Full Redfish tree vs mock BMC: all 16 CI types, hierarchy edges, ingest + idempotency', '8/8 (21 CIs)'],
    ['ssh', 'SSH parsers: os-release, cpuinfo, meminfo, lsblk, ip, df, classification', '7/7'],
    ['vcenter', 'vCenter REST vs mock: Cluster/Host/VM/Datastore CIs + relationships + ingest', '5/5'],
    ['platform', 'RBAC (401/403), audit, CI merge, lifecycle sweep, metrics, CSV', '10/10'],
  ],
  [16, 62, 22],
));
children.push(spacer());
children.push(p('Field validation: a full Redfish sweep against production iLOs produced 1,437 CIs across 16 types (servers, chassis, temperature sensors, firmware, memory, fans, NICs, drives, volumes, …) with no duplicates on re-discovery.'));

// 9. Roadmap
children.push(h1('9. Delivered vs Planned'));
children.push(h3('Delivered in this release'));
children.push(table(
  ['Area', 'Feature'],
  [
    ['Coverage', 'Connectors: Redfish, SNMP (+LLDP L2 topology), vCenter/ESXi (hypervisors + VMs + datastores), SSH/Linux'],
    ['Security', 'API tokens + RBAC (viewer/operator/admin), audit trail — opt-in via CMDB_AUTH'],
    ['CMDB depth', 'Manual CI merge (reassign identifiers/relationships/history, union attributes)'],
    ['Ops', 'Prometheus /metrics, stale→decommissioned CI lifecycle sweep, CSV + Excel bulk export'],
    ['Topology', 'L2 connected_to edges from LLDP neighbours'],
  ],
  [18, 82],
));
children.push(h3('Planned'));
children.push(table(
  ['Area', 'Item'],
  [
    ['Coverage', 'WMI/WinRM (Windows), cloud (AWS/Azure/GCP), storage arrays (SMI-S/REST)'],
    ['Security', 'OIDC/JWT federation, TLS termination, KMS integration'],
    ['CMDB depth', 'CI split, baselines & drift, impact analysis, ServiceNow federation/import'],
    ['Scale', 'Postgres/JSONB backend, collector appliances, durable job queue, horizontal API'],
  ],
  [18, 82],
));

// 10. Traceability
children.push(h1('10. Traceability — Design ↔ Code'));
children.push(table(
  ['Design element', 'Source'],
  [
    ['CI type catalog', 'src/cmdb/model.js'],
    ['Reconciliation engine', 'src/cmdb/reconcile.js · test/recon.test.mjs'],
    ['Data model', 'src/db/schema.sql · src/db/repositories.js'],
    ['Redfish connector (full tree)', 'src/discovery/connectors/redfish.js · test/redfish.test.mjs'],
    ['SNMP connector', 'src/discovery/connectors/snmp.js'],
    ['Orchestrator + scheduler', 'src/discovery/orchestrator.js'],
    ['Credential vault', 'src/crypto/secrets.js'],
    ['REST API', 'src/api/routes.js'],
    ['Excel export', 'src/export/inventory.js'],
    ['Web console', 'src/web/*'],
  ],
  [40, 60],
));

// ---- build ----
const doc = new Document({
  creator: 'OpenCMDB',
  title: 'OpenCMDB Solution Design',
  styles: {
    default: { document: { run: { font: 'Arial', size: 21 } } },
  },
  sections: [{
    properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
    children,
  }],
});

const out = path.join(__dirname, 'OpenCMDB-Solution-Design.docx');
const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(out, buffer);
console.log('Wrote', out, `(${(buffer.length / 1024).toFixed(0)} KB)`);
console.log('Diagrams in', DIA_DIR);
