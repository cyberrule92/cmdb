import crypto from 'node:crypto';
import { Tokens } from '../db/repositories.js';

// Opt-in API authentication + RBAC. Enforcement is ON only when CMDB_AUTH=1,
// so the default deployment (and the live web UI) keeps working unauthenticated.
// Roles: viewer < operator < admin.

export const RANK = { viewer: 1, operator: 2, admin: 3 };
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const newToken = () => 'cmdb_' + crypto.randomBytes(24).toString('hex');

const PUBLIC = new Set(['/api/health', '/metrics']);

function requiredRole(method, url) {
  if (PUBLIC.has(url)) return null;
  if (method === 'GET') return 'viewer';
  // sensitive operations require admin
  if (url.startsWith('/api/tokens') || url.startsWith('/api/lifecycle') ||
      url.startsWith('/api/credentials') || url.includes('/merge')) return 'admin';
  return 'operator'; // other POST/PUT/DELETE
}

export function registerAuth(fastify) {
  const enabled = process.env.CMDB_AUTH === '1';
  fastify.decorate('authEnabled', enabled);

  fastify.addHook('onRequest', async (req, reply) => {
    const url = (req.raw.url || '').split('?')[0];
    // Non-API (static UI assets) and public endpoints are always allowed.
    if (!url.startsWith('/api/') && url !== '/metrics') { req.actor = 'anonymous'; req.role = 'admin'; return; }
    if (!enabled || PUBLIC.has(url)) { req.actor = 'anonymous'; req.role = enabled ? 'viewer' : 'admin'; }

    if (enabled && !PUBLIC.has(url)) {
      // Bootstrap: when auth is enabled but no tokens exist yet, allow creating
      // the first token so an admin can be provisioned.
      if (Tokens.count() === 0 && req.method === 'POST' && url === '/api/tokens') {
        req.actor = 'bootstrap'; req.role = 'admin'; return;
      }
      const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
      const tok = m ? Tokens.findByHash(hashToken(m[1].trim())) : null;
      if (!tok) return reply.code(401).send({ error: 'authentication required' });
      Tokens.touch(tok.id);
      req.actor = tok.name;
      req.role = tok.role;
      const need = requiredRole(req.method, url);
      if (need && RANK[req.role] < RANK[need]) return reply.code(403).send({ error: `role '${need}' required` });
    }
  });
}
