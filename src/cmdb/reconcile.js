import { CIs, Rels, transaction } from '../db/repositories.js';
import { RECON_PRIORITY } from './model.js';

// Promoted columns kept in sync on the `cis` row (also tracked for change history).
const PROMOTED = ['serial', 'uuid', 'model', 'vendor', 'mgmt_ip', 'hostname'];

function normMac(m) {
  if (!m) return null;
  const hex = String(m).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

// Build a deterministic identity key from the strongest available identifier.
// Reconciliation is TYPE-SCOPED: identity keys are prefixed with ci_type so a
// Server can never collapse into a Chassis/Manager that shares the same
// management IP or hostname (they all sit behind one BMC address).
export function reconKey(ci_type, ids) {
  const p = `${ci_type}|`;
  if (ids.serial)   return `${p}serial:${String(ids.serial).trim().toLowerCase()}`;
  if (ids.uuid)     return `${p}uuid:${String(ids.uuid).trim().toLowerCase()}`;
  const mac = (ids.mac || []).map(normMac).filter(Boolean).sort()[0];
  if (mac)          return `${p}mac:${mac}`;
  if (ids.mgmt_ip)  return `${p}ip:${ids.mgmt_ip}`;
  if (ids.hostname) return `${p}host:${String(ids.hostname).trim().toLowerCase()}`;
  return `${p}synthetic:${ids.name || Math.random().toString(36).slice(2)}`;
}

// Locate an existing CI of the SAME type that this descriptor refers to,
// by identifier priority.
function findExisting(ci_type, ids) {
  for (const kind of RECON_PRIORITY) {
    if (kind === 'mac') {
      for (const raw of ids.mac || []) {
        const mac = normMac(raw);
        if (!mac) continue;
        const hit = CIs.findByIdentifier('mac', mac, ci_type);
        if (hit) return hit;
      }
      continue;
    }
    const val = ids[kind];
    if (!val) continue;
    // Promoted columns first (fast, indexed), then the identifier table.
    let hit;
    if (kind === 'serial')   hit = CIs.get(colLookup('serial', val, ci_type));
    else if (kind === 'uuid') hit = CIs.get(colLookup('uuid', val, ci_type));
    else if (kind === 'mgmt_ip') hit = CIs.get(colLookup('mgmt_ip', val, ci_type));
    else if (kind === 'hostname') hit = CIs.get(colLookup('hostname', val, ci_type));
    if (hit) return hit;
    const idKind = kind === 'mgmt_ip' ? 'ip' : kind === 'hostname' ? 'fqdn' : kind;
    const byIdent = CIs.findByIdentifier(idKind, String(val), ci_type);
    if (byIdent) return byIdent;
  }
  return null;
}

import { getDb } from '../db/index.js';
const _db = getDb();
function colLookup(col, val, ci_type) {
  const row = _db.prepare(`SELECT id FROM cis WHERE ${col}=? AND ci_type=? LIMIT 1`)
    .get(String(val), ci_type);
  return row ? row.id : -1;
}

// Upsert one normalized CI descriptor. Returns { ci, created }.
//   descriptor = { ci_type, name, source, ids:{serial,uuid,mac[],mgmt_ip,hostname,asset_tag,...}, attributes:{} }
export function upsertCI(descriptor, runId = null) {
  const { ci_type, name, source } = descriptor;
  const ids = descriptor.ids || {};
  const attrs = descriptor.attributes || {};
  const key = reconKey(ci_type, { ...ids, name });

  return transaction(() => {
    let existing = CIs.getByReconKey(key) || findExisting(ci_type, ids);
    const fields = {
      serial: ids.serial ?? null,
      uuid: ids.uuid ?? null,
      model: attrs.model ?? null,
      vendor: attrs.vendor ?? null,
      mgmt_ip: ids.mgmt_ip ?? null,
      hostname: ids.hostname ?? null,
    };

    let ci, created;
    if (!existing) {
      ci = CIs.insert({
        ci_type, name, recon_key: key, source,
        ...fields,
        attributes_json: JSON.stringify(attrs),
      });
      created = true;
    } else {
      created = false;
      // Merge attributes and record deltas on promoted fields.
      const merged = { ...JSON.parse(existing.attributes_json || '{}'), ...attrs };
      const changeSet = {};
      for (const f of PROMOTED) {
        const nv = fields[f];
        if (nv != null && nv !== '' && String(nv) !== String(existing[f] ?? '')) {
          CIs.recordChange(existing.id, runId, f, existing[f], nv);
          changeSet[f] = nv;
        }
      }
      changeSet.attributes_json = JSON.stringify(merged);
      changeSet.source = source;
      if (name && name !== existing.name) changeSet.name = name;
      ci = CIs.update(existing.id, changeSet);
    }

    // Register every identifier so future sources reconcile to this CI.
    if (ids.serial)   CIs.addIdentifier(ci.id, 'serial', String(ids.serial).trim());
    if (ids.uuid)     CIs.addIdentifier(ci.id, 'uuid', String(ids.uuid).trim());
    if (ids.mgmt_ip)  CIs.addIdentifier(ci.id, 'ip', ids.mgmt_ip);
    if (ids.hostname) CIs.addIdentifier(ci.id, 'fqdn', ids.hostname);
    if (ids.asset_tag) CIs.addIdentifier(ci.id, 'asset_tag', ids.asset_tag);
    for (const raw of ids.mac || []) {
      const mac = normMac(raw);
      if (mac) CIs.addIdentifier(ci.id, 'mac', mac);
    }
    return { ci, created };
  });
}

// Convenience for connectors: upsert a parent, its children, and the relationships.
export function ingestGraph(nodes, edges, runId) {
  const stats = { created: 0, updated: 0 };
  const keyToId = new Map();
  for (const node of nodes) {
    const { ci, created } = upsertCI(node, runId);
    keyToId.set(node._ref, ci.id);
    if (created) stats.created++; else stats.updated++;
  }
  for (const [srcRef, tgtRef, type] of edges) {
    Rels.upsert(keyToId.get(srcRef), keyToId.get(tgtRef), type);
  }
  return stats;
}
