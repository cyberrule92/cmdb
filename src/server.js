import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb } from './db/index.js';
import routes from './api/routes.js';
import { startScheduler } from './discovery/orchestrator.js';

// Build the Fastify app (no socket) — importable for tests via app.inject().
export async function buildApp({ logger = false } = {}) {
  getDb(); // open + migrate the database
  const fastify = Fastify({ logger, bodyLimit: 2 * 1024 * 1024 });

  // Tolerate empty JSON bodies (DELETE / POST-with-no-payload) instead of 400.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body || !body.trim()) return done(null, {});
    try { done(null, JSON.parse(body)); }
    catch (err) { err.statusCode = 400; done(err); }
  });

  await fastify.register(fastifyCors, { origin: true });
  await fastify.register(routes);
  await fastify.register(fastifyStatic, { root: config.webDir, prefix: '/' });

  // SPA fallback for the single-page UI.
  fastify.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
  return fastify;
}

async function start() {
  const fastify = await buildApp({ logger: { level: process.env.LOG_LEVEL || 'info' } });
  startScheduler(fastify.log);
  try {
    await fastify.listen({ host: config.host, port: config.port });
    fastify.log.info(`OpenCMDB listening on http://${config.host}:${config.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Only start a listening server when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) start();
