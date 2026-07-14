import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.CMDB_DATA_DIR || path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const config = {
  host: process.env.CMDB_HOST || '0.0.0.0',
  port: Number(process.env.CMDB_PORT || 8080),
  dbPath: process.env.CMDB_DB || path.join(DATA_DIR, 'cmdb.db'),
  // 32-byte key (hex) used to encrypt stored credentials. Auto-generated & persisted
  // on first run if not supplied via env. In production, inject via secret manager.
  secretKeyFile: path.join(DATA_DIR, '.secret.key'),
  // Discovery tuning
  discovery: {
    concurrency: Number(process.env.CMDB_DISCOVERY_CONCURRENCY || 32),
    connectTimeoutMs: Number(process.env.CMDB_CONNECT_TIMEOUT || 8000),
    maxTargetsPerJob: Number(process.env.CMDB_MAX_TARGETS || 65536),
  },
  // CI lifecycle: mark CIs not seen for N days stale, then decommissioned.
  lifecycle: {
    staleDays: Number(process.env.CMDB_STALE_DAYS || 7),
    decomDays: Number(process.env.CMDB_DECOM_DAYS || 30),
  },
  webDir: path.join(__dirname, 'web'),
};
