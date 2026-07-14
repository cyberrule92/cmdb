// OpenCMDB single-page console (no build step, native ES modules).
const $ = (s, r = document) => r.querySelector(s);
const main = $('#main');

async function api(path, opts = {}) {
  // Only send a JSON content-type when there is actually a body — otherwise
  // Fastify rejects the empty body with 400 (breaks DELETE and POST /run).
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const tok = localStorage.getItem('cmdb_token');
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v) => (v == null || v === '' ? '<span class="muted">—</span>' : esc(v));
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

let CATALOG = {}; // ci type -> {category,label,icon}
function catOf(type) { return CATALOG[type]?.category || 'component'; }
function labelOf(type) { return CATALOG[type]?.label || type; }
function typeBadge(type) { return `<span class="badge ${catOf(type)}">${esc(labelOf(type))}</span>`; }

// Recursively render an attribute object as a clean key/value table.
function renderAttrs(obj, depth = 0) {
  if (obj === null || obj === undefined) return '<span class="muted">—</span>';
  if (typeof obj !== 'object') return esc(String(obj));
  if (Array.isArray(obj)) {
    if (!obj.length) return '<span class="muted">[]</span>';
    if (obj.every((v) => typeof v !== 'object')) return esc(obj.join(', '));
    return obj.map((v) => `<div class="attr-arr">${renderAttrs(v, depth + 1)}</div>`).join('');
  }
  const keys = Object.keys(obj);
  if (!keys.length) return '<span class="muted">{}</span>';
  return `<table class="attr-tbl">${keys.map((k) => `<tr>
    <th>${esc(k.replace(/_/g, ' '))}</th><td>${renderAttrs(obj[k], depth + 1)}</td></tr>`).join('')}</table>`;
}

// Render the Redfish-style resource hierarchy tree.
function renderTree(node, isRoot = true) {
  if (!node) return '';
  const rel = node.rel && !isRoot ? `<span class="rel-verb">${esc(node.rel)}</span> ` : '';
  const kids = (node.children || []).map((c) => renderTree(c, false)).join('');
  return `<li>
    <div class="tree-node" onclick="event.stopPropagation();openCI(${node.id})">
      ${rel}<span class="tree-dot ${catOf(node.ci_type)}"></span>
      <span class="tree-label">${esc(node.name)}</span> ${typeBadge(node.ci_type)}
    </div>
    ${kids ? `<ul>${kids}</ul>` : ''}
  </li>`;
}

// ---- connection indicator ----
async function pingLoop() {
  try { await api('/health'); $('#conn-dot').className = 'dot ok'; $('#conn-text').textContent = 'connected'; }
  catch { $('#conn-dot').className = 'dot bad'; $('#conn-text').textContent = 'offline'; }
  setTimeout(pingLoop, 5000);
}

// =========================================================================
// Dashboard
// =========================================================================
async function viewDashboard() {
  const stats = await api('/stats');
  CATALOG = stats.types;
  const byType = stats.byType.sort((a, b) => b.n - a.n);
  const runs = stats.recentRuns;
  const catTotals = {};
  for (const r of byType) { const c = catOf(r.ci_type); catTotals[c] = (catTotals[c] || 0) + r.n; }

  main.innerHTML = `
    <div class="page-head"><div>
      <h1>Dashboard</h1><p>Discovered configuration items across your estate</p>
    </div><a class="btn" href="#/discovery">Run discovery →</a></div>

    <div class="tiles">
      <div class="tile accent"><div class="n">${stats.total}</div><div class="l">Total CIs</div></div>
      <div class="tile"><div class="n">${catTotals.compute || 0}</div><div class="l">Compute</div></div>
      <div class="tile"><div class="n">${catTotals.network || 0}</div><div class="l">Network</div></div>
      <div class="tile"><div class="n">${catTotals.storage || 0}</div><div class="l">Storage</div></div>
      <div class="tile"><div class="n">${catTotals.component || 0}</div><div class="l">Components</div></div>
    </div>

    <div class="grid-2">
      <div class="panel"><h2>Inventory by CI type</h2><div class="table-wrap">
        <table><thead><tr><th>Type</th><th>Category</th><th style="text-align:right">Count</th></tr></thead><tbody>
        ${byType.length ? byType.map((r) => `<tr onclick="location.hash='#/inventory?type=${r.ci_type}'">
          <td>${typeBadge(r.ci_type)}</td><td class="muted">${esc(catOf(r.ci_type))}</td>
          <td style="text-align:right" class="mono">${r.n}</td></tr>`).join('')
        : `<tr><td colspan="3" class="empty">No CIs yet — run a discovery job.</td></tr>`}
        </tbody></table></div></div>

      <div class="panel"><h2>Recent discovery runs</h2><div class="table-wrap">
        <table><thead><tr><th>Run</th><th>Status</th><th>Reached</th><th>New / Upd</th><th>When</th></tr></thead><tbody>
        ${runs.length ? runs.map((r) => `<tr onclick="location.hash='#/discovery'">
          <td class="mono">#${r.id}</td>
          <td><span class="status ${r.status}">${r.status}</span></td>
          <td class="mono">${r.targets_reached}/${r.targets_total}</td>
          <td class="mono">+${r.cis_created} / ~${r.cis_updated}</td>
          <td class="muted">${esc((r.started_at || '').replace('T', ' '))}</td></tr>`).join('')
        : `<tr><td colspan="5" class="empty">No runs yet.</td></tr>`}
        </tbody></table></div></div>
    </div>`;
}

// =========================================================================
// Inventory
// =========================================================================
async function viewInventory(params) {
  const type = params.get('type') || '';
  const q = params.get('q') || '';
  if (!Object.keys(CATALOG).length) CATALOG = (await api('/stats')).types;

  main.innerHTML = `
    <div class="page-head"><div><h1>Inventory</h1><p>Browse and search all configuration items</p></div>
      <div style="display:flex;gap:8px">
        <a class="btn ghost" id="export-csv" href="/api/export/inventory.csv" download>⬇ CSV</a>
        <a class="btn" id="export-btn" href="/api/export/inventory.xlsx" download>⬇ Export Excel</a>
      </div></div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search name, serial, IP, model…" value="${esc(q)}" />
      <select id="type"><option value="">All types</option>
        ${Object.keys(CATALOG).map((t) => `<option value="${t}" ${t === type ? 'selected' : ''}>${esc(CATALOG[t].label)}</option>`).join('')}
      </select>
    </div>
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Vendor / Model</th><th>Serial</th><th>Mgmt IP</th><th>Status</th><th>Last seen</th></tr></thead>
      <tbody id="rows"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
    </table></div></div>`;

  const load = async () => {
    const qp = new URLSearchParams();
    if ($('#type').value) qp.set('type', $('#type').value);
    if ($('#q').value) qp.set('q', $('#q').value);
    // keep the Excel export in sync with the active filter
    const eq = qp.toString();
    $('#export-btn').href = `/api/export/inventory.xlsx${eq ? '?' + eq : ''}`;
    $('#export-csv').href = `/api/export/inventory.csv${eq ? '?' + eq : ''}`;
    $('#export-btn').textContent = eq ? '⬇ Export Excel (filtered)' : '⬇ Export Excel';
    const rows = await api('/cis?' + eq);
    $('#rows').innerHTML = rows.length ? rows.map((c) => `
      <tr onclick="openCI(${c.id})">
        <td><strong>${esc(c.name)}</strong></td>
        <td>${typeBadge(c.ci_type)}</td>
        <td>${fmt([c.vendor, c.model].filter(Boolean).join(' '))}</td>
        <td class="mono">${fmt(c.serial)}</td>
        <td class="mono">${fmt(c.mgmt_ip)}</td>
        <td><span class="status ${c.status}">${c.status}</span></td>
        <td class="muted">${esc((c.last_seen || '').replace('T', ' '))}</td>
      </tr>`).join('') : `<tr><td colspan="7" class="empty">No matching CIs.</td></tr>`;
  };
  let deb;
  $('#q').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(load, 250); });
  $('#type').addEventListener('change', load);
  await load();
}

// ---- shared CI detail renderer (used by drawer + full page) ----
function ciDetailBody(ci, tree, full) {
  const attrs = ci.attributes || {};
  const rels = ci.relationships || [];
  const hasChildren = tree && tree.children && tree.children.length;
  const relRow = (r) => {
    const out = r.source_id === ci.id;
    const other = out ? { id: r.target_id, name: r.target_name, type: r.target_type }
                      : { id: r.source_id, name: r.source_name, type: r.source_type };
    return `<li><span class="rel-verb">${out ? '' : '◄ '}${esc(r.type)}${out ? ' ►' : ''}</span>
      <a onclick="openCI(${other.id})">${esc(other.name)}</a> ${typeBadge(other.type)}</li>`;
  };
  return `
    <dl class="kv">
      <dt>Vendor</dt><dd>${fmt(ci.vendor)}</dd>
      <dt>Model</dt><dd>${fmt(ci.model)}</dd>
      <dt>Serial</dt><dd class="mono">${fmt(ci.serial)}</dd>
      <dt>UUID</dt><dd class="mono">${fmt(ci.uuid)}</dd>
      <dt>Mgmt IP</dt><dd class="mono">${fmt(ci.mgmt_ip)}</dd>
      <dt>Hostname</dt><dd>${fmt(ci.hostname)}</dd>
      <dt>Source</dt><dd>${fmt(ci.source)}</dd>
      <dt>First seen</dt><dd class="muted">${esc((ci.first_seen || '').replace('T', ' '))}</dd>
      <dt>Last seen</dt><dd class="muted">${esc((ci.last_seen || '').replace('T', ' '))}</dd>
    </dl>
    ${hasChildren ? `<div class="section-title">Resource Hierarchy</div>
      <ul class="tree">${renderTree(tree)}</ul>` : ''}
    <div class="section-title">Relationships (${rels.length})</div>
    ${rels.length ? `<ul class="rel-list">${rels.map(relRow).join('')}</ul>` : '<p class="muted">No relationships.</p>'}
    <div class="section-title">Attributes (${Object.keys(attrs).length})</div>
    <div class="attr-box${full ? ' full' : ''}">${renderAttrs(attrs)}</div>
    ${ci.changes?.length ? `<div class="section-title">Change history (${ci.changes.length})</div>
      <ul class="rel-list">${ci.changes.map((c) => `<li><span class="rel-verb">${esc(c.field)}</span>
        <span class="muted">${fmt(c.old_value)}</span> → ${fmt(c.new_value)}
        <span class="muted" style="margin-left:auto">${esc((c.changed_at || '').replace('T', ' '))}</span></li>`).join('')}</ul>` : ''}`;
}
const ciNewTabHref = (id) => `${location.pathname}#/ci/${id}`;

// ---- CI detail drawer (quick view) ----
window.openCI = async function (id) {
  const drawer = $('#drawer'), scrim = $('#drawer-scrim');
  drawer.classList.add('open'); scrim.classList.add('open');
  $('.drawer-body', drawer).innerHTML = '<div class="loading">Loading…</div>';
  const [ci, tree] = await Promise.all([api(`/cis/${id}`), api(`/cis/${id}/tree`).catch(() => null)]);
  $('.drawer-body', drawer).innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;gap:10px">
      <div><h1 style="margin:0;font-size:20px">${esc(ci.name)}</h1>
        <div style="margin-top:6px">${typeBadge(ci.ci_type)} <span class="status ${ci.status}">${ci.status}</span></div></div>
      <div style="display:flex;gap:8px;flex:0 0 auto">
        <a class="btn ghost sm" href="${ciNewTabHref(id)}" target="_blank" rel="noopener">Open in new tab ↗</a>
        <button class="btn ghost sm" onclick="closeDrawer()">✕</button>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin:10px 0">
      <button class="btn ghost sm" onclick="mergeCI(${id})">Merge duplicate in…</button>
      <button class="btn ghost sm" onclick="decommCI(${id})">Decommission</button>
    </div>
    ${ciDetailBody(ci, tree, false)}`;
};
window.mergeCI = async function (survivorId) {
  const victim = prompt('Merge which CI (id) INTO this one? The other CI will be removed and its identifiers/relationships reassigned here.');
  if (!victim) return;
  try { await api('/cis/merge', { method: 'POST', body: { survivor_id: survivorId, victim_id: Number(victim) } }); toast('Merged'); openCI(survivorId); }
  catch (e) { toast(e.message, true); }
};
window.decommCI = async function (id) {
  if (!confirm('Mark this CI as decommissioned?')) return;
  try { await api(`/cis/${id}/decommission`, { method: 'POST' }); toast('Decommissioned'); openCI(id); }
  catch (e) { toast(e.message, true); }
};
window.closeDrawer = () => { $('#drawer').classList.remove('open'); $('#drawer-scrim').classList.remove('open'); };
$('#drawer-scrim').addEventListener('click', window.closeDrawer);

// ---- CI detail full page (#/ci/:id) ----
async function viewCI(params) {
  const id = Number(params.get('id'));
  main.innerHTML = '<div class="loading">Loading…</div>';
  if (!Object.keys(CATALOG).length) CATALOG = (await api('/stats')).types;
  const [ci, tree] = await Promise.all([api(`/cis/${id}`), api(`/cis/${id}/tree`).catch(() => null)]);
  document.title = `${ci.name} — OpenCMDB`;
  main.innerHTML = `
    <div class="page-head"><div>
      <div style="margin-bottom:6px"><a href="#/inventory" class="muted">← Inventory</a></div>
      <h1>${esc(ci.name)}</h1>
      <p>${typeBadge(ci.ci_type)} <span class="status ${ci.status}">${ci.status}</span></p>
    </div></div>
    <div class="ci-page">${ciDetailBody(ci, tree, true)}</div>`;
}

// =========================================================================
// Discovery
// =========================================================================
async function viewDiscovery() {
  const [jobs, creds] = await Promise.all([api('/jobs'), api('/credentials')]);
  main.innerHTML = `
    <div class="page-head"><div><h1>Discovery</h1><p>Define and run discovery jobs against your infrastructure</p></div></div>
    <div class="grid-2">
      <div class="form-card">
        <h2 style="margin:0 0 6px;font-size:15px">New discovery job</h2>
        <p class="muted" style="margin:0 0 8px;font-size:12px">Targets accept IPs, CIDR (10.0.0.0/24), or ranges (10.0.0.5-40), comma or newline separated.</p>
        <label>Name</label><input id="j-name" placeholder="DC1 iLO sweep" />
        <label>Connector</label>
        <select id="j-conn">
          <option value="redfish">Redfish (iLO / baremetal)</option>
          <option value="snmp">SNMP (network / servers)</option>
          <option value="vcenter">vCenter / ESXi (hypervisors + VMs)</option>
          <option value="ssh">SSH (Linux / Unix)</option>
        </select>
        <label>Credential</label>
        <select id="j-cred"><option value="">— none —</option>
          ${creds.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.type})</option>`).join('')}</select>
        <label>Targets</label>
        <textarea id="j-targets" rows="3" placeholder="10.20.30.0/24&#10;10.20.31.5-40"></textarea>
        <label>Port (optional)</label><input id="j-port" type="number" placeholder="443 / 161" style="width:140px" />
        <div style="margin-top:14px"><button class="btn" id="j-save">Create job</button></div>
      </div>
      <div class="panel"><h2>Jobs</h2><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Connector</th><th>Targets</th><th></th></tr></thead>
        <tbody id="jobs">${jobs.length ? '' : '<tr><td colspan="4" class="empty">No jobs yet.</td></tr>'}</tbody>
      </table></div></div>
    </div>
    <div class="panel"><h2>Recent runs</h2><div class="table-wrap"><table>
      <thead><tr><th>Run</th><th>Job</th><th>Status</th><th>Reached</th><th>New / Upd</th><th>When</th><th></th></tr></thead>
      <tbody id="runs"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody></table></div></div>`;

  const renderJobs = (list) => {
    $('#jobs').innerHTML = list.length ? list.map((j) => `<tr>
      <td><strong>${esc(j.name)}</strong></td>
      <td><span class="badge">${esc(j.connector)}</span></td>
      <td class="mono muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.targets)}</td>
      <td style="white-space:nowrap">
        <button class="btn sm" ${j.running ? 'disabled' : ''} onclick="runJob(${j.id})">${j.running ? 'running…' : '▶ Run'}</button>
        <button class="btn sm danger" onclick="delJob(${j.id})">✕</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">No jobs yet.</td></tr>';
  };
  renderJobs(jobs);

  const loadRuns = async () => {
    const runs = await api('/runs');
    const jmap = Object.fromEntries((await api('/jobs')).map((j) => [j.id, j.name]));
    $('#runs').innerHTML = runs.length ? runs.map((r) => `<tr>
      <td class="mono">#${r.id}</td><td>${esc(jmap[r.job_id] || '—')}</td>
      <td><span class="status ${r.status}">${r.status}</span></td>
      <td class="mono">${r.targets_reached}/${r.targets_total}</td>
      <td class="mono">+${r.cis_created} / ~${r.cis_updated}</td>
      <td class="muted">${esc((r.started_at || '').replace('T', ' '))}</td>
      <td><button class="btn ghost sm" onclick="showRun(${r.id})">log</button></td></tr>`).join('')
      : '<tr><td colspan="7" class="empty">No runs yet.</td></tr>';
  };
  await loadRuns();
  window.__loadRuns = loadRuns;

  $('#j-save').addEventListener('click', async () => {
    const body = {
      name: $('#j-name').value.trim(),
      connector: $('#j-conn').value,
      targets: $('#j-targets').value.trim(),
      credential_id: $('#j-cred').value ? Number($('#j-cred').value) : null,
      port: $('#j-port').value ? Number($('#j-port').value) : null,
    };
    if (!body.name || !body.targets) return toast('Name and targets required', true);
    try { await api('/jobs', { method: 'POST', body }); toast('Job created'); route(); }
    catch (e) { toast(e.message, true); }
  });
}

window.runJob = async function (id) {
  try {
    const res = await api(`/jobs/${id}/run`, { method: 'POST' });
    toast(`Discovery started (run #${res.run?.id ?? '?'})`);
    const runId = res.run?.id;
    // poll this run until it finishes, then refresh tables
    const poll = setInterval(async () => {
      const run = await api(`/runs/${runId}`);
      if (run.status !== 'running') {
        clearInterval(poll);
        toast(`Run #${runId} ${run.status}: +${run.cis_created} new, reached ${run.targets_reached}/${run.targets_total}`, run.status === 'failed');
        if (location.hash.startsWith('#/discovery')) route();
      }
    }, 1500);
  } catch (e) { toast(e.message, true); }
};
window.delJob = async function (id) {
  if (!confirm('Delete this job?')) return;
  await api(`/jobs/${id}`, { method: 'DELETE' }); route();
};
window.showRun = async function (id) {
  const run = await api(`/runs/${id}`);
  const drawer = $('#drawer'), scrim = $('#drawer-scrim');
  drawer.classList.add('open'); scrim.classList.add('open');
  $('.drawer-body', drawer).innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start">
      <h1 style="margin:0;font-size:20px">Run #${run.id}</h1>
      <button class="btn ghost sm" onclick="closeDrawer()">✕</button></div>
    <dl class="kv">
      <dt>Status</dt><dd><span class="status ${run.status}">${run.status}</span></dd>
      <dt>Reached</dt><dd class="mono">${run.targets_reached} / ${run.targets_total}</dd>
      <dt>Created</dt><dd class="mono">${run.cis_created}</dd>
      <dt>Updated</dt><dd class="mono">${run.cis_updated}</dd>
      <dt>Started</dt><dd class="muted">${esc((run.started_at || '').replace('T', ' '))}</dd>
      <dt>Finished</dt><dd class="muted">${esc((run.finished_at || '').replace('T', ' '))}</dd>
      ${run.error ? `<dt>Error</dt><dd style="color:var(--red)">${esc(run.error)}</dd>` : ''}
    </dl>
    <div class="section-title">Per-target log (${run.log.length})</div>
    <div class="attr-json">${run.log.map((l) => `<div class="log-line ${l.ok ? 'ok' : 'err'}">${l.ok ? '✓' : '✗'} ${esc(l.host)} — ${esc(l.msg || '')}${l.created != null ? ` (+${l.created}/~${l.updated})` : ''}</div>`).join('') || '<span class="muted">no entries</span>'}</div>`;
};

// =========================================================================
// Credentials
// =========================================================================
async function viewCredentials() {
  const creds = await api('/credentials');
  main.innerHTML = `
    <div class="page-head"><div><h1>Credentials</h1><p>Secrets are encrypted at rest (AES-256-GCM) and never returned by the API</p></div></div>
    <div class="grid-2">
      <div class="form-card">
        <h2 style="margin:0 0 12px;font-size:15px">Add credential</h2>
        <label>Name</label><input id="c-name" placeholder="ilo-admin" />
        <label>Type</label>
        <select id="c-type"><option value="redfish">Redfish (iLO)</option>
          <option value="snmpv2c">SNMP v2c</option><option value="snmpv3">SNMP v3</option>
          <option value="vcenter">vCenter / ESXi</option><option value="ssh">SSH (Linux)</option></select>
        <div id="c-fields"></div>
        <div style="margin-top:14px"><button class="btn" id="c-save">Save credential</button></div>
      </div>
      <div class="panel"><h2>Stored credentials</h2><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Type</th><th>User</th><th></th></tr></thead>
        <tbody>${creds.length ? creds.map((c) => `<tr>
          <td><strong>${esc(c.name)}</strong></td><td><span class="badge">${esc(c.type)}</span></td>
          <td>${fmt(c.username)}</td>
          <td><button class="btn sm danger" onclick="delCred(${c.id})">✕</button></td></tr>`).join('')
          : '<tr><td colspan="4" class="empty">No credentials.</td></tr>'}</tbody>
      </table></div></div>
    </div>`;

  const fields = $('#c-fields');
  const renderFields = () => {
    const t = $('#c-type').value;
    if (t === 'redfish' || t === 'vcenter') fields.innerHTML = `<label>Username</label><input id="f-user" />
      <label>Password</label><input id="f-pass" type="password" />`;
    else if (t === 'ssh') fields.innerHTML = `<label>Username</label><input id="f-user" />
      <label>Password</label><input id="f-pass" type="password" placeholder="(or use private key)" />
      <label>Private key (optional, PEM)</label><textarea id="f-key" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>`;
    else if (t === 'snmpv2c') fields.innerHTML = `<label>Community</label><input id="f-community" placeholder="public" />`;
    else fields.innerHTML = `<label>Username</label><input id="f-user" />
      <label>Security level</label><select id="f-level"><option>authPriv</option><option>authNoPriv</option><option>noAuthNoPriv</option></select>
      <label>Auth protocol</label><select id="f-authp"><option>sha</option><option>md5</option></select>
      <label>Auth key</label><input id="f-authk" type="password" />
      <label>Priv protocol</label><select id="f-privp"><option>aes</option><option>des</option></select>
      <label>Priv key</label><input id="f-privk" type="password" />`;
  };
  $('#c-type').addEventListener('change', renderFields);
  renderFields();

  $('#c-save').addEventListener('click', async () => {
    const t = $('#c-type').value;
    const body = { name: $('#c-name').value.trim(), type: t };
    if (!body.name) return toast('Name required', true);
    if (t === 'redfish' || t === 'vcenter') { body.username = $('#f-user').value; body.secret = { password: $('#f-pass').value }; }
    else if (t === 'ssh') { body.username = $('#f-user').value; body.secret = {}; if ($('#f-pass').value) body.secret.password = $('#f-pass').value; if ($('#f-key').value.trim()) body.secret.privateKey = $('#f-key').value; }
    else if (t === 'snmpv2c') { body.secret = { community: $('#f-community').value || 'public' }; }
    else {
      body.username = $('#f-user').value;
      body.secret = { level: $('#f-level').value, authProtocol: $('#f-authp').value, authKey: $('#f-authk').value,
        privProtocol: $('#f-privp').value, privKey: $('#f-privk').value };
    }
    try { await api('/credentials', { method: 'POST', body }); toast('Credential saved'); route(); }
    catch (e) { toast(e.message, true); }
  });
}
window.delCred = async function (id) {
  if (!confirm('Delete credential?')) return;
  await api(`/credentials/${id}`, { method: 'DELETE' }); route();
};

// =========================================================================
// Access & Audit
// =========================================================================
async function viewAccess() {
  const [health, tokens, audit] = await Promise.all([api('/health'), api('/tokens'), api('/audit')]);
  const active = localStorage.getItem('cmdb_token') || '';
  main.innerHTML = `
    <div class="page-head"><div><h1>Access &amp; Audit</h1>
      <p>RBAC tokens and the audit trail. Enforcement is ${health.auth ? '<strong>ON</strong>' : 'OFF (set CMDB_AUTH=1 to enable)'}.</p></div></div>
    <div class="grid-2">
      <div class="form-card">
        <h2 style="margin:0 0 12px;font-size:15px">Create API token</h2>
        <label>Name</label><input id="tk-name" placeholder="ci-automation" />
        <label>Role</label><select id="tk-role"><option value="viewer">viewer (read)</option>
          <option value="operator">operator (run/create)</option><option value="admin">admin (all)</option></select>
        <div style="margin-top:14px"><button class="btn" id="tk-save">Create token</button></div>
        <hr style="border-color:var(--border);margin:18px 0"/>
        <h2 style="margin:0 0 8px;font-size:15px">This browser's token</h2>
        <p class="muted" style="font-size:12px;margin:0 0 6px">Used as Bearer for API calls when auth is enabled.</p>
        <input id="tk-active" placeholder="paste a token" value="${esc(active)}" style="width:100%" />
        <div style="margin-top:10px"><button class="btn ghost" id="tk-set">Save to browser</button></div>
      </div>
      <div class="panel"><h2>Tokens</h2><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Role</th><th>Last used</th><th></th></tr></thead>
        <tbody>${tokens.length ? tokens.map((t) => `<tr>
          <td><strong>${esc(t.name)}</strong></td><td><span class="badge">${esc(t.role)}</span></td>
          <td class="muted">${esc((t.last_used || '—').replace('T', ' '))}</td>
          <td><button class="btn sm danger" onclick="delTok(${t.id})">✕</button></td></tr>`).join('')
          : '<tr><td colspan="4" class="empty">No tokens.</td></tr>'}</tbody></table></div></div>
    </div>
    <div class="panel"><h2>Audit log</h2><div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
      <tbody>${audit.length ? audit.map((a) => `<tr>
        <td class="muted">${esc((a.ts || '').replace('T', ' '))}</td><td>${esc(a.actor)}</td>
        <td><span class="badge">${esc(a.action)}</span></td><td class="mono">${fmt(a.target)}</td>
        <td class="muted">${fmt(a.detail)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">No activity yet.</td></tr>'}
    </tbody></table></div></div>`;

  $('#tk-save').addEventListener('click', async () => {
    const name = $('#tk-name').value.trim();
    if (!name) return toast('Name required', true);
    try {
      const r = await api('/tokens', { method: 'POST', body: { name, role: $('#tk-role').value } });
      prompt('Token created — copy it now (shown once):', r.token);
      route();
    } catch (e) { toast(e.message, true); }
  });
  $('#tk-set').addEventListener('click', () => {
    const v = $('#tk-active').value.trim();
    if (v) localStorage.setItem('cmdb_token', v); else localStorage.removeItem('cmdb_token');
    toast('Saved token to this browser');
  });
}
window.delTok = async function (id) { if (!confirm('Delete token?')) return; await api(`/tokens/${id}`, { method: 'DELETE' }); route(); };

// =========================================================================
// Topology / dependency graph (force-directed SVG, no external libs)
// =========================================================================
const CAT_COLOR = {
  compute: '#4f8cff', mgmt: '#c4b5fd', network: '#6ee7b7', storage: '#fbbf24',
  component: '#94a3b8', power: '#f472b6', cooling: '#67e8f9', sensor: '#fca5a5',
  firmware: '#a78bfa', software: '#5eead4',
};
const colorFor = (type) => CAT_COLOR[catOf(type)] || '#94a3b8';

function flattenTree(tree) {
  const nodes = [], edges = [];
  (function walk(n) {
    nodes.push({ id: n.id, label: n.name, type: n.ci_type });
    for (const c of n.children || []) { edges.push({ source_id: n.id, target_id: c.id, type: c.rel }); walk(c); }
  })(tree);
  return { nodes, edges };
}

async function viewTopology(params) {
  if (!Object.keys(CATALOG).length) CATALOG = (await api('/stats')).types;
  const [roots, servers] = await Promise.all([api('/roots'), api('/servers')]);
  const srvOpt = (s) => `<option value="machine:${s.id}">${esc(s.name)}${s.model ? ' — ' + esc(s.model) : ''}${s.mgmt_ip ? ' (' + esc(s.mgmt_ip) + ')' : ''}</option>`;
  main.innerHTML = `
    <div class="page-head"><div><h1>Topology</h1><p>Dependency &amp; containment graph — drag to pan, scroll to zoom, click a node</p></div></div>
    <div class="toolbar">
      <select id="t-root">
        <option value="">Whole estate</option>
        ${servers.length ? `<optgroup label="Redfish servers">${servers.map(srvOpt).join('')}</optgroup>` : ''}
        <optgroup label="All roots">${roots.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(labelOf(r.ci_type))}</option>`).join('')}</optgroup>
      </select>
      <label style="margin:0;display:flex;align-items:center;gap:6px">Depth
        <select id="t-depth">
          <option value="1">1</option><option value="2" selected>2</option><option value="3">3</option>
          <option value="">All</option>
        </select></label>
      <span class="muted" id="t-count"></span>
      <span style="margin-left:auto" class="legend">${Object.entries(CAT_COLOR).map(([c, col]) => `<span class="lg"><i style="background:${col}"></i>${c}</span>`).join('')}</span>
    </div>
    <div class="graph-wrap"><svg id="graph" width="100%" height="640"></svg>
      <div class="empty" id="t-empty" style="display:none">No graph yet — run a discovery job.</div></div>`;

  const svg = $('#graph');
  const draw = async () => {
    const sel = $('#t-root').value;
    const depth = $('#t-depth').value;
    const parts = [];
    if (depth) parts.push(`depth=${depth}`);
    let g;
    if (!sel) {
      g = await api(`/topology${parts.length ? '?' + parts.join('&') : ''}`);
    } else if (sel.startsWith('machine:')) {
      parts.push('scope=machine');
      g = flattenTree(await api(`/cis/${sel.slice(8)}/tree?${parts.join('&')}`));
    } else {
      g = flattenTree(await api(`/cis/${sel}/tree${parts.length ? '?' + parts.join('&') : ''}`));
    }
    $('#t-count').textContent = `${g.nodes.length} nodes · ${g.edges.length} edges${depth ? ` · depth ${depth}` : ''}`;
    $('#t-empty').style.display = g.nodes.length ? 'none' : 'block';
    renderGraph(svg, g);
  };
  $('#t-root').addEventListener('change', draw);
  $('#t-depth').addEventListener('change', draw);
  await draw();
}

function renderGraph(svg, g) {
  svg.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';
  const W = svg.clientWidth || 900, H = 640;
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]));
  const N = g.nodes.map((n) => ({ ...n, x: W / 2 + (Math.random() - 0.5) * 400, y: H / 2 + (Math.random() - 0.5) * 400, vx: 0, vy: 0 }));
  const E = g.edges.map((e) => ({ s: idx.get(e.source_id), t: idx.get(e.target_id), type: e.type })).filter((e) => e.s != null && e.t != null);
  const deg = N.map(() => 0); E.forEach((e) => { deg[e.s]++; deg[e.t]++; });

  const gEdges = document.createElementNS(NS, 'g');
  const gNodes = document.createElementNS(NS, 'g');
  const root = document.createElementNS(NS, 'g');
  root.appendChild(gEdges); root.appendChild(gNodes); svg.appendChild(root);

  const lines = E.map((e) => {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('stroke', 'rgba(138,151,173,.35)'); l.setAttribute('stroke-width', '1');
    gEdges.appendChild(l); return l;
  });
  const circles = N.map((n) => {
    const c = document.createElementNS(NS, 'g'); c.setAttribute('class', 'gnode'); c.style.cursor = 'pointer';
    const r = 5 + Math.min(deg[idx.get(n.id)] || 0, 8);
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('r', r); dot.setAttribute('fill', colorFor(n.type));
    dot.setAttribute('stroke', '#0f1420'); dot.setAttribute('stroke-width', '1.5');
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('font-size', '10'); label.setAttribute('fill', '#c7d0df');
    label.setAttribute('x', r + 3); label.setAttribute('y', 3);
    label.textContent = n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label;
    c.appendChild(dot); c.appendChild(label);
    const t = document.createElementNS(NS, 'title'); t.textContent = `${n.label} · ${labelOf(n.type)}`; c.appendChild(t);
    c.addEventListener('click', () => openCI(n.id));
    gNodes.appendChild(c); return c;
  });

  // ---- force simulation (animated settle) ----
  const K = 0.02, REP = 1400, LEN = 60;
  let frame = 0;
  const step = () => {
    for (let i = 0; i < N.length; i++) {
      for (let j = i + 1; j < N.length; j++) {
        let dx = N[i].x - N[j].x, dy = N[i].y - N[j].y;
        let d2 = dx * dx + dy * dy || 0.01; const f = REP / d2;
        const d = Math.sqrt(d2); const fx = (dx / d) * f, fy = (dy / d) * f;
        N[i].vx += fx; N[i].vy += fy; N[j].vx -= fx; N[j].vy -= fy;
      }
    }
    for (const e of E) {
      const a = N[e.s], b = N[e.t];
      let dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = K * (d - LEN); const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    for (const n of N) {
      n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002;
      n.vx *= 0.85; n.vy *= 0.85; n.x += n.vx; n.y += n.vy;
    }
    E.forEach((e, i) => { lines[i].setAttribute('x1', N[e.s].x); lines[i].setAttribute('y1', N[e.s].y); lines[i].setAttribute('x2', N[e.t].x); lines[i].setAttribute('y2', N[e.t].y); });
    N.forEach((n, i) => circles[i].setAttribute('transform', `translate(${n.x},${n.y})`));
    if (++frame < 260) requestAnimationFrame(step);
  };
  if (N.length) step();

  // ---- pan & zoom ----
  const vb = { x: 0, y: 0, w: W, h: H };
  const apply = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  apply();
  svg.onwheel = (ev) => {
    ev.preventDefault(); const s = ev.deltaY > 0 ? 1.1 : 0.9;
    const mx = vb.x + (ev.offsetX / svg.clientWidth) * vb.w, my = vb.y + (ev.offsetY / H) * vb.h;
    vb.w *= s; vb.h *= s; vb.x = mx - (ev.offsetX / svg.clientWidth) * vb.w; vb.y = my - (ev.offsetY / H) * vb.h; apply();
  };
  let drag = null;
  svg.onmousedown = (ev) => { drag = { x: ev.clientX, y: ev.clientY }; };
  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    vb.x -= (ev.clientX - drag.x) * (vb.w / svg.clientWidth); vb.y -= (ev.clientY - drag.y) * (vb.h / H);
    drag = { x: ev.clientX, y: ev.clientY }; apply();
  });
  window.addEventListener('mouseup', () => { drag = null; });
}

// =========================================================================
// Router
// =========================================================================
const VIEWS = { dashboard: viewDashboard, inventory: viewInventory, topology: viewTopology, discovery: viewDiscovery, credentials: viewCredentials, access: viewAccess, ci: viewCI };

async function route() {
  const raw = location.hash.replace(/^#\//, '') || 'dashboard';
  const [pathPart, qs] = raw.split('?');
  const segments = pathPart.split('/');            // supports #/ci/123
  const name = segments[0];
  const params = new URLSearchParams(qs || '');
  if (segments[1]) params.set('id', segments[1]);
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  const view = VIEWS[name] || viewDashboard;
  try { await view(params); }
  catch (e) { main.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
if (!location.hash) location.hash = '#/dashboard';
route();
pingLoop();
