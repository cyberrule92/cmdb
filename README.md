# OpenCMDB

Enterprise hardware asset **discovery** and **CMDB** for baremetal, hypervisors,
VMs, storage, and network — inspired by the architecture of OpenText uCMDB
(system of record + reconciliation) and HPE OpsRamp (agentless discovery +
inventory). Real discovery, no simulated data.

## What it does

- **Agentless discovery** over four protocols:
  - **Redfish** (HPE iLO / DMTF BMCs → full baremetal hardware tree)
  - **SNMP v2c/v3** (network devices + servers; **LLDP** → L2 `connected_to` topology)
  - **vCenter / ESXi** (vSphere REST → clusters, hypervisors, VMs, datastores)
  - **SSH** (Linux/Unix → CPU/memory/disks/NICs/filesystems)
- **CMDB core** — typed Configuration Items (CIs), directed relationships
  (topology), a **reconciliation engine** giving each asset one stable identity
  across sources (type-scoped serial → UUID → MAC → IP → hostname), **change
  history**, and manual **CI merge**.
- **CI lifecycle** — CIs unseen for N days go `stale` then `decommissioned`.
- **Security** — encrypted credential vault (AES-256-GCM); opt-in **API tokens +
  RBAC** (viewer/operator/admin) and an **audit trail** (`CMDB_AUTH=1`).
- **Observability & export** — Prometheus `/metrics`; filter-aware **Excel** and
  **CSV** inventory reports.
- **Web console** — dashboard, searchable inventory, CI detail (hierarchy tree +
  attributes + full-page view), dependency **topology** graph, discovery jobs,
  and **Access & Audit**.

## Quick start

```bash
npm install
CMDB_PORT=8099 npm start          # http://localhost:8099
```

That's the whole setup. On first run the app creates `data/`, migrates the
SQLite schema and generates the credential-vault key — no separate database
step. (`npm run init-db` exists if you want to create the DB without starting
the server, but `npm start` does it for you.)

> **A fresh clone starts empty.** `data/` is gitignored, so the repo carries no
> database — you get an empty CMDB and populate it by running discovery.

> **Back up `data/.secret.key` with your database.** It is auto-generated on
> first run and it is the only thing that can decrypt the credentials stored in
> `data/cmdb.db`. Restoring the DB without the key leaves every stored
> credential unreadable. In production, inject the key via `CMDB_SECRET_KEY`
> from a secret manager instead of relying on the generated file.

Then in the UI:

1. **Credentials →** add your iLO (Redfish) login and/or SNMP community/v3 user.
2. **Discovery →** create a job:
   - connector `Redfish`, targets = your iLO IPs / CIDR, credential = iLO login.
   - connector `SNMP`, targets = switch/server management subnet, port 161.
3. Click **▶ Run**. Discovered assets appear under **Inventory**.

> Discovery runs from *this host* — it must have network reachability to your
> iLO (443) and SNMP (161) targets.

## Configuration (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `CMDB_PORT` | `8080` | HTTP port |
| `CMDB_HOST` | `0.0.0.0` | bind address |
| `CMDB_DB` | `data/cmdb.db` | SQLite path |
| `CMDB_SECRET_KEY` | auto-generated | 64-hex (32-byte) vault key; inject in prod |
| `CMDB_DISCOVERY_CONCURRENCY` | `32` | parallel targets per job |
| `CMDB_CONNECT_TIMEOUT` | `8000` | per-target connect timeout (ms) |
| `CMDB_AUTH` | _(off)_ | `1` enables API token auth + RBAC |
| `CMDB_STALE_DAYS` | `7` | days unseen before a CI is marked `stale` |
| `CMDB_DECOM_DAYS` | `30` | days unseen before a CI is `decommissioned` |

## Tests

```bash
npm test                      # reconciliation engine + full Redfish-tree connector
```

## Solution design document

```bash
npm run docs                  # regenerates the Word doc + diagrams
```

- **`docs/OpenCMDB-Solution-Design.docx`** — HLD + LLD + 7 technical diagrams
  (architecture, data flow, ER data model, reconciliation flow, discovery
  sequence, Redfish resource model, deployment).
- **`docs/diagrams/*.svg` / `*.png`** — the diagrams on their own.
- **`docs/DESIGN.md`** — the same design in Markdown.

## Layout

```
src/
  server.js              Fastify bootstrap + static UI + scheduler
  config.js              env-driven config
  crypto/secrets.js      AES-256-GCM credential vault
  db/                    schema.sql, connection, repositories (data layer)
  cmdb/                  model.js (CI types), reconcile.js (identity engine)
  discovery/
    targets.js           IP / CIDR / range expansion
    orchestrator.js      job runner (concurrency) + scheduler
    connectors/          redfish.js, snmp.js
  api/routes.js          REST API
  web/                   single-page console (no build step)
docs/DESIGN.md           HLD + LLD solution design
```

See **[docs/DESIGN.md](docs/DESIGN.md)** for the full architecture and design.
