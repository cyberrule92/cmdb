# OpenCMDB — Architecture & Solution Design (HLD + LLD)

**Product:** Enterprise hardware asset discovery & configuration management
database for baremetal, hypervisors, VMs, storage, and network.
**Status:** v0.1 (working foundation) · **Audience:** architects, platform/SRE, security.

---

## 1. Context & reference-product analysis

The two reference products solve adjacent problems. OpenCMDB targets the
intersection: **discover → normalize → manage** a hardware asset inventory.

| Capability | OpenText **uCMDB** | HPE **OpsRamp** | **OpenCMDB (this)** |
|---|---|---|---|
| Primary role | System of record (CMDB) | Hybrid IT ops & monitoring | Discovery + CMDB inventory |
| CI type model (CITs) | Rich, extensible | Resource-type based | Typed CI catalog (`cmdb/model.js`) |
| Discovery | Universal Discovery (SNMP/WMI/SSH + agent) | Agent + agentless gateway | Agentless: Redfish + SNMP (extensible) |
| **Reconciliation** | Identification & reconciliation rules | Resource de-dup | Identifier-priority engine (`reconcile.js`) |
| Topology / relationships | Full graph + impact analysis | Service maps | Directed relationship graph |
| Credentials | Protocol credential vault | Vault + gateway | AES-256-GCM vault |
| Deployment | Server + Data Flow Probes | SaaS + collector appliances | Single node; collector model on roadmap |
| Change tracking | History + baselines | Change events | Per-run attribute change log |

**Design stance:** keep the *core* (CI model, reconciliation, relationships,
API) small and correct; make *discovery* a pluggable connector interface so new
protocols (vCenter, WMI/WinRM, cloud APIs, SSH) are additive.

### Non-goals for v1
Monitoring/alerting/AIOps, agent-based collection, multi-tenancy, and RBAC are
deliberately out of scope for the foundation and called out on the roadmap (§9).

---

## 2. High-Level Design (HLD)

### 2.1 Component architecture

```
                         ┌──────────────────────────────────────────────┐
                         │                 Web Console (SPA)             │
                         │  Dashboard · Inventory · Discovery · Creds     │
                         └───────────────────────┬──────────────────────┘
                                                 │ HTTPS / REST (JSON)
                         ┌───────────────────────▼──────────────────────┐
                         │                 API Layer (Fastify)           │
                         │   /api/cis /jobs /runs /credentials /topology │
                         └───┬───────────────┬───────────────┬──────────┘
                             │               │               │
              ┌──────────────▼───┐   ┌───────▼────────┐  ┌───▼───────────────┐
              │  CMDB Core       │   │  Discovery      │  │  Credential Vault │
              │  · CI model      │   │  Orchestrator   │  │  AES-256-GCM      │
              │  · Reconciliation│◄──┤  · job runner   │  └───────────────────┘
              │  · Relationships │   │  · scheduler    │
              │  · Change log    │   │  · concurrency  │
              └──────┬───────────┘   └───────┬─────────┘
                     │                       │  pluggable connector interface
              ┌──────▼───────────┐   ┌───────▼────────────┬───────────────┐
              │  Data Layer      │   │  Redfish connector │  SNMP connector│
              │  repositories.js │   │  (iLO / BMC → HW)  │  (v2c / v3)    │
              └──────┬───────────┘   └────────┬───────────┴──────┬────────┘
                     │                        │ HTTPS:443         │ UDP:161
              ┌──────▼───────────┐   ┌────────▼───────────────────▼────────┐
              │  SQLite (WAL)    │   │        Customer infrastructure       │
              │  CIs·rels·runs   │   │   iLO BMCs · switches · servers      │
              └──────────────────┘   └──────────────────────────────────────┘
```

### 2.2 End-to-end data flow

1. **Configure** — operator stores protocol credentials (vault) and defines a
   *discovery job* (connector + target spec + credential).
2. **Expand** — orchestrator expands targets (IP / CIDR / range) into a host list.
3. **Probe** — a bounded worker pool runs the connector against each host,
   returning a normalized **CI graph** `{nodes[], edges[]}`.
4. **Reconcile & ingest** — each node is resolved to a new or existing CI by
   identifier priority; attributes merge, deltas are logged, relationships upsert.
5. **Serve** — CIs, relationships, change history, and run logs are exposed via
   REST and rendered in the console.

### 2.3 Technology choices & rationale

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ (ESM) | Async I/O fits fan-out network discovery; one language across API + UI |
| API | Fastify | Lightweight, fast, schema-friendly |
| Store | SQLite (WAL) via better-sqlite3 | Zero-ops embedded DB; synchronous = simple transactional reconciliation. Data layer abstracted for Postgres |
| Redfish | axios + Node https | Self-signed-cert handling for BMCs |
| SNMP | net-snmp (pure JS) | v2c + v3, no native deps |
| Concurrency | p-limit | Bounded parallel probing |
| Vault | node:crypto AES-256-GCM | Authenticated encryption, no external KMS dependency for v1 |

---

## 3. Low-Level Design (LLD) — data model

SQLite schema (`src/db/schema.sql`). Hot identity/query fields are promoted to
indexed columns; the long tail of attributes lives in `attributes_json`
(portable to Postgres `JSONB`).

### 3.1 Core entities

```
cis(id, ci_type, name, recon_key⋆, serial, uuid, model, vendor,
    mgmt_ip, hostname, status, source, attributes_json, first_seen, last_seen)
      ⋆ recon_key UNIQUE — deterministic identity key

ci_identifiers(id, ci_id→cis, kind, value)      UNIQUE(kind,value)
      kind ∈ {serial, uuid, mac, ip, fqdn, asset_tag}   -- alternate keys for recon

relationships(id, source_id→cis, target_id→cis, type)   UNIQUE(source,target,type)
      type ∈ {contains, runs_on, connected_to, managed_by, member_of}

ci_changes(id, ci_id→cis, run_id→runs, field, old_value, new_value, changed_at)

credentials(id, name, type, username, secret_blob⋆)      ⋆ AES-256-GCM sealed
discovery_jobs(id, name, connector, targets, credential_id, port, options_json,
               enabled, schedule_sec)
discovery_runs(id, job_id, status, started_at, finished_at,
               targets_total, targets_reached, cis_created, cis_updated, error, log_json)
```

### 3.2 CI type catalog (CITs)

`Server, Hypervisor, VM, Chassis, Manager(BMC), NetworkDevice,
NetworkInterface, Storage, Drive, Processor, Memory` — each mapped to a category
(compute / network / storage / mgmt / component) and icon (`cmdb/model.js`).
New types are additive metadata, not schema changes.

### 3.3 Relationship semantics

`Chassis ─contains→ Server ─contains→ {Processor, Memory, Drive}`,
`Server ─managed_by→ Manager`, `VM ─runs_on→ Hypervisor`,
`NetworkInterface ─connected_to→ NetworkInterface` (L2/L3, roadmap correlation).

---

## 4. LLD — Reconciliation engine (`cmdb/reconcile.js`)

The heart of the CMDB: collapse observations from multiple sources/runs into one
authoritative CI per physical asset.

### 4.1 Identity key

`reconKey(type, ids)` picks the strongest present identifier and is
**type-scoped** — the key is prefixed with the CI type:

```
{ci_type}|  serial  >  uuid  >  mac(normalized, lowest)  >  mgmt_ip  >  hostname  >  synthetic
```

Result e.g. `Server|serial:sgh1234abc`. Stored UNIQUE in `cis.recon_key`.
Type-scoping is essential: a Chassis, Server and Manager discovered via one BMC
all share the same management IP, so an un-scoped `mgmt_ip` match would wrongly
collapse them into one CI. Scoping also prevents a NIC and its host from merging
on a shared MAC. All identifier lookups filter by `ci_type`.

### 4.2 Match algorithm (upsert)

```
1. exact match on recon_key
2. else, in priority order (serial, uuid, mac, mgmt_ip, hostname):
     lookup promoted column (indexed)  → hit? use it
     lookup ci_identifiers(kind,value) → hit? use it
3. no match  → INSERT new CI
   match     → MERGE: attributes_json ← {…existing, …incoming}
               record ci_changes for each changed promoted field
               update last_seen
4. register ALL incoming identifiers in ci_identifiers
   so a future source that shares ANY identifier reconciles to this CI
```

This is what lets a **Redfish**-discovered server (known by *serial*) and the
same box seen later by **SNMP** (known only by *MAC*) become **one** CI — proven
in `test/recon.test.mjs`.

### 4.3 Integrity & correctness

- Whole ingest of one host runs in a **SQLite transaction** (`transaction()`),
  so a partial failure leaves no half-written CI graph.
- MACs are normalized (`aabbcc001122` → `aa:bb:cc:00:11:22`) before compare.
- Synthetic serials for child components are **parent-scoped**
  (`{serial}:cpu:1`) to guarantee cross-server uniqueness without false merges.
- BMC and host deliberately **do not** share the management IP as an identifier,
  preventing the Manager and Server CIs from collapsing.

### 4.4 Known limitation → roadmap
If two CIs are created from disjoint identifiers and a *later* observation proves
them identical, v1 keeps both. A **merge/split** operation (uCMDB-style) is the
planned enhancement (§9).

---

## 5. LLD — Discovery connectors

### 5.1 Connector contract

```js
async function discover(host, credential, opts)
  → { reached: bool, nodes: [CIDescriptor], edges: [[srcRef, tgtRef, relType]],
      error?, summary? }

CIDescriptor = { _ref, ci_type, name, source,
                 ids:{serial,uuid,mac[],mgmt_ip,hostname,asset_tag},
                 attributes:{…} }
```
Adding a protocol = one file implementing this contract + registration in
`orchestrator.js`. No core changes.

### 5.2 Redfish / iLO (`connectors/redfish.js`)

Walks the **full** DMTF Redfish tree over HTTPS (Basic auth, self-signed
tolerated), emitting a first-class CI for **every** node in the hierarchy:

```
/redfish/v1/
  Chassis ──contains──► Server(ComputeSystem) ──contains──► Processor
   │                     │                                   Memory
   │                     │                                   EthernetInterface
   │                     │                                   Drive · Volume
   │                     └──managed_by──► Manager(BMC) ──contains──► NetworkInterface
   ├──contains──► NetworkAdapter · PCIeDevice(Devices)
   ├──contains──► PowerSupply
   └──contains──► Fan · TemperatureSensor
  UpdateService ──► Firmware[] · Software[]   (linked to the Server)
```

Every resource's complete attribute set is preserved by `attrsFrom()` (scalars,
arrays and value-objects, with `Status` flattened and `@odata`/nav-refs dropped).
System Ethernet MACs key their own `EthernetInterface` CIs so an SNMP-discovered
interface reconciles to the same port. Verified end-to-end against a mock Redfish
server in `test/redfish.test.mjs` — **one baremetal → 21 CIs**, idempotent on
re-discovery.

### 5.3 SNMP (`connectors/snmp.js`)

v2c and v3 (auth/priv). Reads:

- **system group** (`sysDescr/Name/Location/Services/ObjectID`) → device identity
  and **classification** (Hypervisor / NetworkDevice / Server via descr + services).
- **ifTable + ifXTable** → `NetworkInterface` CIs (name, MAC, speed, oper/admin).
- **ENTITY-MIB** physical table → chassis serial / model / vendor.

Produces `NetworkDevice|Server|Hypervisor + NetworkInterface[]` with `contains` edges.

---

## 6. LLD — Orchestration, API, scheduler

### 6.1 Job runner (`discovery/orchestrator.js`)
- Expands targets (`discovery/targets.js`: IP / CIDR — network+broadcast excluded
  for blocks / `a-b` range / last-octet shorthand), capped by `maxTargetsPerJob`.
- Bounded worker pool (`p-limit`, `CMDB_DISCOVERY_CONCURRENCY`).
- Per-target isolation: one host failing never fails the run; errors captured in
  `discovery_runs.log_json`. Status = success / partial / failed.
- Run row is created synchronously so the API can return `202` and the UI polls.

### 6.2 REST API (`api/routes.js`)

| Method & path | Purpose |
|---|---|
| `GET /api/stats` | totals by type + recent runs |
| `GET /api/cis?type&q&status&limit` | filtered inventory |
| `GET /api/cis/:id` | CI + attributes + relationships + change history |
| `GET /api/cis/:id/tree` | Redfish-style containment hierarchy (recursive) |
| `GET /api/roots` | top-level CIs (hierarchy roots) |
| `GET /api/topology?limit` | dependency graph nodes + edges |
| `GET/POST/DELETE /api/credentials` | vault (secrets never returned) |
| `GET/POST/DELETE /api/jobs`, `POST /api/jobs/:id/run` | discovery jobs |
| `GET /api/runs`, `/api/runs/:id` | run status + per-target log |

### 6.3 Scheduler
15-second tick evaluates `schedule_sec` on enabled jobs; due & not-already-running
jobs are launched. Simple, in-process; a durable queue is the scale path (§9).

---

## 7. Security design

- **Credentials at rest:** AES-256-GCM (`crypto/secrets.js`), format
  `v1:iv:tag:ciphertext`. Key from `CMDB_SECRET_KEY` (inject via secret manager)
  or a `0600` keyfile. Secret material never leaves the server (`Credentials.list`
  omits `secret_blob`).
- **Transport:** discovery uses HTTPS (Redfish) and SNMP v3 auth/priv where
  available; SNMP v2c community strings are supported but flagged as low-assurance.
- **Injection safety:** all DB access uses parameterized prepared statements.
- **Hardening roadmap:** API auth (OIDC/JWT) + RBAC, per-request audit, TLS
  termination, secret-manager/KMS integration, network segmentation for probes.

---

## 8. Deployment & scale

**v1 (current):** single Node process, embedded SQLite — suitable for a lab,
a data-center pod, or an appliance. Runs where it can reach the targets.

**Scale-out target (OpsRamp-like collector model):**

```
  Central plane (API + Postgres/JSONB + reconciliation)
        ▲            ▲
        │ results    │ results        (mTLS)
   ┌────┴────┐  ┌────┴────┐
   │Collector│  │Collector│   ← deployed per site/VLAN; run connectors locally,
   └─────────┘  └─────────┘     stream normalized CI graphs upstream (job queue)
```

Migration levers already in place: data layer isolated in `repositories.js`
(swap SQLite→Postgres), connector contract stable, jobs/runs modeled for a queue.

---

## 9. Roadmap

| Phase | Items |
|---|---|
| **Hardening** | AuthN/AuthZ (OIDC + RBAC), audit log, TLS, secret-manager |
| **Coverage** | Connectors: vCenter (pyvmomi-equiv via API), WMI/WinRM, SSH (Linux), cloud (AWS/Azure/GCP), storage arrays (SMI-S/REST) |
| **CMDB depth** | Manual merge/split, CI baselines & drift, impact analysis, federation/import |
| **Topology** | L2/L3 correlation (LLDP/CDP, FDB, ARP) → `connected_to` edges; graph view |
| **Scale** | Postgres + Neo4j option, collector appliances, durable job queue, horizontal API |
| **Ops** | Prometheus metrics, stale-CI lifecycle, bulk export (CSV/ServiceNow) |

---

## 10. Traceability — design ↔ code

| Design element | Source |
|---|---|
| CI type catalog | `src/cmdb/model.js` |
| Reconciliation engine | `src/cmdb/reconcile.js` · test `test/recon.test.mjs` |
| Data model | `src/db/schema.sql` · `src/db/repositories.js` |
| Full Redfish tree connector | `src/discovery/connectors/redfish.js` · test `test/redfish.test.mjs` |
| SNMP connector | `src/discovery/connectors/snmp.js` |
| Hierarchy tree + dependency graph | `api/routes.js` (`/tree`,`/roots`,`/topology`) · `web/app.js` |
| Orchestrator + scheduler | `src/discovery/orchestrator.js` |
| Target expansion | `src/discovery/targets.js` |
| Credential vault | `src/crypto/secrets.js` |
| REST API | `src/api/routes.js` |
| Web console | `src/web/*` |
