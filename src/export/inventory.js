import ExcelJS from 'exceljs';
import { CIs, Rels } from '../db/repositories.js';
import { CI_TYPES } from '../cmdb/model.js';

// Flatten a (possibly nested) attribute object into scalar cells with dotted keys.
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      out[key] = v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v);
    } else if (typeof v === 'object') {
      flatten(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A44' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = HEADER_FONT;
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

// Excel sheet names: ≤31 chars, none of []:*?/\
const safeName = (s) => s.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);

// Flat CSV of the (optionally filtered) inventory — for bulk export / ingestion.
export function buildInventoryCsv(filter = {}) {
  const cols = ['id', 'ci_type', 'name', 'vendor', 'model', 'serial', 'uuid', 'mgmt_ip', 'hostname', 'status', 'source', 'first_seen', 'last_seen'];
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const c of CIs.allFull(filter)) lines.push(cols.map((k) => q(c[k])).join(','));
  return lines.join('\n') + '\n';
}

export async function buildInventoryWorkbook(filter = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OpenCMDB';
  wb.created = new Date();

  const cis = CIs.allFull(filter);
  const includedIds = new Set(cis.map((c) => c.id));

  // Counts scoped to the filtered set.
  const counts = {};
  for (const c of cis) counts[c.ci_type] = (counts[c.ci_type] || 0) + 1;

  // ---- Summary ----
  const sum = wb.addWorksheet('Summary');
  const filterBits = [
    filter.type ? `type=${filter.type}` : null,
    filter.q ? `search="${filter.q}"` : null,
    filter.status ? `status=${filter.status}` : null,
  ].filter(Boolean);
  sum.mergeCells('A1:C1');
  sum.getCell('A1').value = `OpenCMDB inventory — ${filterBits.length ? 'filtered (' + filterBits.join(', ') + ')' : 'full estate'} — ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
  sum.getCell('A1').font = { italic: true, color: { argb: 'FF8A97AD' } };
  sum.addRow([]);
  const hdr = sum.addRow(['CI Type', 'Category', 'Count']);
  hdr.font = HEADER_FONT; hdr.fill = HEADER_FILL;
  sum.columns = [{ width: 26 }, { width: 16 }, { width: 10 }];
  for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    sum.addRow([CI_TYPES[t]?.label || t, CI_TYPES[t]?.category || '', n]);
  }
  sum.addRow([]);
  sum.addRow(['TOTAL', '', cis.length]).font = { bold: true };

  // ---- All CIs (flat overview) ----
  const all = wb.addWorksheet('All CIs');
  all.columns = [
    { header: 'ID', key: 'id', width: 6 },
    { header: 'Type', key: 'ci_type', width: 20 },
    { header: 'Name', key: 'name', width: 34 },
    { header: 'Vendor', key: 'vendor', width: 16 },
    { header: 'Model', key: 'model', width: 26 },
    { header: 'Serial', key: 'serial', width: 24 },
    { header: 'UUID', key: 'uuid', width: 30 },
    { header: 'Mgmt IP', key: 'mgmt_ip', width: 15 },
    { header: 'Hostname', key: 'hostname', width: 22 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Source', key: 'source', width: 10 },
    { header: 'First Seen', key: 'first_seen', width: 20 },
    { header: 'Last Seen', key: 'last_seen', width: 20 },
  ];
  for (const c of cis) all.addRow(c);
  styleHeader(all);

  // ---- One detailed sheet per CI type (base fields + all flattened attributes) ----
  const byType = {};
  for (const c of cis) (byType[c.ci_type] ||= []).push(c);

  for (const [type, rows] of Object.entries(byType)) {
    // Union of attribute keys across all CIs of this type.
    const attrKeys = new Set();
    const flat = rows.map((r) => {
      const f = flatten(JSON.parse(r.attributes_json || '{}'));
      Object.keys(f).forEach((k) => attrKeys.add(k));
      return f;
    });
    // Drop attribute keys already shown as base columns.
    const BASE = new Set(['vendor', 'model']);
    const attrCols = [...attrKeys].filter((k) => !BASE.has(k)).sort();
    const ws = wb.addWorksheet(safeName(CI_TYPES[type]?.label || type));
    ws.columns = [
      { header: 'Name', key: 'name', width: 32 },
      { header: 'Serial', key: 'serial', width: 22 },
      { header: 'Mgmt IP', key: 'mgmt_ip', width: 15 },
      { header: 'Vendor', key: 'vendor', width: 16 },
      { header: 'Model', key: 'model', width: 24 },
      { header: 'Status', key: 'status', width: 11 },
      ...attrCols.map((k) => ({ header: k, key: `attr.${k}`, width: 18 })),
    ];
    rows.forEach((r, i) => {
      const row = { name: r.name, serial: r.serial, mgmt_ip: r.mgmt_ip, vendor: r.vendor, model: r.model, status: r.status };
      for (const k of attrCols) row[`attr.${k}`] = flat[i][k] ?? '';
      ws.addRow(row);
    });
    styleHeader(ws);
  }

  // ---- Relationships ----
  const rel = wb.addWorksheet('Relationships');
  rel.columns = [
    { header: 'Source', key: 'source', width: 32 },
    { header: 'Source Type', key: 'source_type', width: 18 },
    { header: 'Relationship', key: 'rel', width: 16 },
    { header: 'Target', key: 'target', width: 32 },
    { header: 'Target Type', key: 'target_type', width: 18 },
  ];
  for (const r of Rels.allDetailed()) {
    if (includedIds.has(r.source_id) && includedIds.has(r.target_id)) rel.addRow(r);
  }
  styleHeader(rel);

  return wb;
}
