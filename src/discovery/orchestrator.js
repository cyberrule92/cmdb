import pLimit from 'p-limit';
import { config } from '../config.js';
import { Jobs, Runs, Credentials, CIs } from '../db/repositories.js';
import { openSecret } from '../crypto/secrets.js';
import { ingestGraph } from '../cmdb/reconcile.js';
import { expandTargets } from './targets.js';
import * as redfish from './connectors/redfish.js';
import * as snmpConn from './connectors/snmp.js';
import * as vcenter from './connectors/vcenter.js';
import * as ssh from './connectors/ssh.js';

const CONNECTORS = { redfish, snmp: snmpConn, vcenter, ssh };

// Resolve the vault credential into the shape connectors expect.
function loadCredential(credential_id) {
  if (!credential_id) return null;
  const row = Credentials.get(credential_id);
  if (!row) throw new Error(`credential ${credential_id} not found`);
  return { type: row.type, username: row.username, secret: openSecret(row.secret_blob) };
}

const running = new Set(); // job ids currently executing

export function isRunning(jobId) { return running.has(jobId); }

// Execute one discovery job. Returns the finished run row.
export async function runJob(jobId, logger = console) {
  const job = Jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  if (running.has(jobId)) throw new Error(`job ${jobId} already running`);

  const connector = CONNECTORS[job.connector];
  if (!connector) throw new Error(`unknown connector: ${job.connector}`);

  const cred = loadCredential(job.credential_id);
  const opts = { ...JSON.parse(job.options_json || '{}'), port: job.port || undefined };
  const targets = expandTargets(job.targets, config.discovery.maxTargetsPerJob);

  running.add(jobId);
  const runId = Runs.start(jobId, targets.length);
  logger.log?.(`[run ${runId}] job "${job.name}" (${job.connector}) → ${targets.length} target(s)`);

  const limit = pLimit(config.discovery.concurrency);
  const log = [];
  let reached = 0, created = 0, updated = 0;

  const tasks = targets.map((host) => limit(async () => {
    try {
      const res = await connector.discover(host, cred, opts);
      if (!res.reached) {
        if (res.error) log.push({ host, ok: false, msg: res.error });
        return;
      }
      reached++;
      const stats = ingestGraph(res.nodes || [], res.edges || [], runId);
      created += stats.created;
      updated += stats.updated;
      log.push({ host, ok: true, msg: res.summary, created: stats.created, updated: stats.updated });
    } catch (err) {
      log.push({ host, ok: false, msg: err.message });
    }
  }));

  let status = 'success';
  let error = null;
  try {
    await Promise.all(tasks);
    if (reached === 0 && targets.length > 0) status = 'failed';
    else if (log.some((l) => !l.ok)) status = 'partial';
  } catch (err) {
    status = 'failed';
    error = err.message;
  }

  Runs.finish(runId, {
    status, targets_reached: reached, cis_created: created, cis_updated: updated, error,
    log: log.slice(0, 2000),
  });
  running.delete(jobId);
  logger.log?.(`[run ${runId}] done: ${status} — reached ${reached}/${targets.length}, +${created} new, ~${updated} updated`);
  return Runs.get(runId);
}

// ---- CI lifecycle sweep ---------------------------------------------------
// Mark CIs not seen for staleDays as 'stale', and beyond decomDays as
// 'decommissioned'. Returns how many transitioned.
export function runLifecycleSweep(staleDays = config.lifecycle.staleDays, decomDays = config.lifecycle.decomDays) {
  const iso = (days) => new Date(Date.now() - days * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
  const decom = CIs.decommissionBefore(iso(decomDays)).changes;
  const stale = CIs.markStaleBefore(iso(staleDays)).changes;
  return { stale, decommissioned: decom };
}

// ---- Lightweight interval scheduler --------------------------------------
let schedulerTimer = null;
const lastRun = new Map();
let lastSweep = 0;

export function startScheduler(logger = console) {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    const now = Date.now();
    for (const job of Jobs.listScheduled()) {
      const due = (lastRun.get(job.id) || 0) + job.schedule_sec * 1000;
      if (now >= due && !isRunning(job.id)) {
        lastRun.set(job.id, now);
        runJob(job.id, logger).catch((e) => logger.error?.(`scheduled job ${job.id} failed: ${e.message}`));
      }
    }
    // Daily CI lifecycle sweep.
    if (now - lastSweep > 86400_000) {
      lastSweep = now;
      const r = runLifecycleSweep();
      if (r.stale || r.decommissioned) logger.log?.(`lifecycle sweep: ${r.stale} stale, ${r.decommissioned} decommissioned`);
    }
  }, 15000);
  schedulerTimer.unref?.();
  logger.log?.('scheduler started (15s tick)');
}

export function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}
