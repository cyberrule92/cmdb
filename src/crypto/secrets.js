import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';

// AES-256-GCM encryption for credentials at rest.
// Key is loaded from CMDB_SECRET_KEY (64 hex chars) or a persisted keyfile.

function loadKey() {
  const env = process.env.CMDB_SECRET_KEY;
  if (env) {
    const buf = Buffer.from(env, 'hex');
    if (buf.length !== 32) throw new Error('CMDB_SECRET_KEY must be 64 hex chars (32 bytes)');
    return buf;
  }
  try {
    const hex = fs.readFileSync(config.secretKeyFile, 'utf8').trim();
    return Buffer.from(hex, 'hex');
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(config.secretKeyFile, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

const KEY = loadKey();

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: v1:iv:tag:ciphertext (all base64)
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob) {
  const [ver, ivB64, tagB64, dataB64] = String(blob).split(':');
  if (ver !== 'v1') throw new Error('unsupported secret format');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Encrypt an object's secret fields, returning a single opaque blob.
export function sealSecret(obj) {
  return encrypt(JSON.stringify(obj));
}
export function openSecret(blob) {
  return JSON.parse(decrypt(blob));
}
