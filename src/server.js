// LecoLista API · Fastify + SQLite cache + scraping ML
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { searchPrice as searchCarrefour } from './scrapers/carrefour.js';
import { searchPrice as searchBuscape } from './scrapers/buscape.js';
import { initSyncDB, createSpace, findSpaceByCode, findSpaceById, touchSpace, pushRecords, pullRecords, spaceStats } from './sync-db.js';
import { createHash } from 'node:crypto';

initSyncDB(process.env.DB_PATH || '/data/lecolista.db');

function hashPin(pin) {
  if (!pin) return null;
  return createHash('sha256').update('lecolista:' + String(pin).trim()).digest('hex').slice(0, 16);
}

// Carrefour primeiro (supermercado real, preços alimentícios reais).
// Buscapé como fallback (agregador, mas tem categoria errada pra mantimentos).
async function searchPrice(query) {
  const cf = await searchCarrefour(query);
  if (cf.found) return cf;
  const bsc = await searchBuscape(query);
  if (bsc.found) return bsc;
  return cf;
}
import { getCached, savePrice, bumpStat, getStats, getRecent, normalize } from './db.js';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
// Em produção, Traefik tem PathPrefix(/api) + middleware stripprefix automático
// (gerado pelo Coolify), então o backend recebe /v1/... limpo.
// BASE_PATH só é útil pra ambientes onde NÃO há strip-prefix (dev local).
const BASE_PATH = process.env.BASE_PATH || '';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://lista.devbyle.co').split(',').map((s) => s.trim());

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true,
});

// CORS continua restrito, mas é só pra dev local — em produção, mesma origem.
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin || CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS · origem não permitida'), false);
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
});

await app.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  hook: 'onRequest',
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.ip,
});

// ── Rotas v1 (registradas com prefixo BASE_PATH = '/api' em produção) ──
app.register(async (api) => {
  api.get('/v1/health', async () => ({
    ok: true,
    service: 'lecolista-api',
    version: '0.1.0',
    uptime: Math.floor(process.uptime()),
    now: new Date().toISOString(),
  }));

  api.get('/v1/stats', async () => ({
    stats: getStats(),
    recent: getRecent(20),
  }));

  // GET /api/v1/price?q=leite+integral[&refresh=1]
  api.get('/v1/price', async (req, reply) => {
    bumpStat('requests_total');
    const q = String(req.query.q || '').trim();
    if (!q) return reply.code(400).send({ error: 'query "q" obrigatória' });
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';

    if (!refresh) {
      const cached = getCached(q);
      if (cached) {
        bumpStat('cache_hits');
        return {
          found: !!cached.found,
          price: cached.price,
          currency: cached.currency,
          title: cached.title,
          link: cached.link,
          thumbnail: cached.thumbnail,
          source: cached.source,
          cached: true,
          fetchedAt: cached.fetched_at,
          query: normalize(q),
        };
      }
    }

    bumpStat('cache_misses');
    const r = await searchPrice(q);
    savePrice(q, r);
    if (!r.found) bumpStat('scrape_errors');
    return {
      found: !!r.found,
      price: r.price ?? null,
      currency: r.currency ?? 'BRL',
      title: r.title ?? null,
      link: r.link ?? null,
      thumbnail: r.thumbnail ?? null,
      source: r.source ?? null,
      error: r.error ?? null,
      cached: false,
      fetchedAt: Date.now(),
      query: normalize(q),
    };
  });

  // POST /api/v1/price/batch  { queries: ["leite", "pão"], refresh?: false }
  api.post('/v1/price/batch', async (req, reply) => {
    const { queries = [], refresh = false } = req.body || {};
    if (!Array.isArray(queries) || queries.length === 0) {
      return reply.code(400).send({ error: 'body.queries deve ser array não-vazio' });
    }
    if (queries.length > 25) {
      return reply.code(400).send({ error: 'max 25 queries por request' });
    }

    bumpStat('requests_total');
    const results = {};
    for (const q of queries) {
      const norm = normalize(q);
      if (!refresh) {
        const c = getCached(q);
        if (c) {
          results[norm] = {
            found: !!c.found, price: c.price, currency: c.currency,
            title: c.title, link: c.link, source: c.source,
            cached: true, fetchedAt: c.fetched_at,
          };
          bumpStat('cache_hits');
          continue;
        }
      }
      bumpStat('cache_misses');
      const r = await searchPrice(q);
      savePrice(q, r);
      if (!r.found) bumpStat('scrape_errors');
      results[norm] = {
        found: !!r.found, price: r.price ?? null, currency: r.currency ?? 'BRL',
        title: r.title ?? null, link: r.link ?? null, source: r.source ?? null,
        error: r.error ?? null, cached: false, fetchedAt: Date.now(),
      };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { results, count: queries.length };
  });

  // ── SYNC: multi-device ────────────────────────────────────
  // POST /v1/spaces  body: { name?: string, pin?: '1234' } → { code, id }
  api.post('/v1/spaces', async (req, reply) => {
    const { name, pin } = req.body || {};
    const s = createSpace(name || null, hashPin(pin));
    return { code: s.code, id: s.id, name: s.name, created_at: s.created_at };
  });

  // POST /v1/spaces/join  body: { code: 'ABCD-1234', pin?: '1234' } → { id, name }
  api.post('/v1/spaces/join', async (req, reply) => {
    const { code, pin } = req.body || {};
    if (!code) return reply.code(400).send({ error: 'code obrigatório' });
    const space = findSpaceByCode(code);
    if (!space) return reply.code(404).send({ error: 'grupo não encontrado' });
    if (space.pin_hash && space.pin_hash !== hashPin(pin)) {
      return reply.code(401).send({ error: 'PIN do grupo incorreto' });
    }
    touchSpace(space.id);
    return { id: space.id, name: space.name, code: space.code };
  });

  // GET /v1/spaces/:id/pull?since=TS → registros modificados depois de TS
  api.get('/v1/spaces/:id/pull', async (req, reply) => {
    const { id } = req.params;
    const space = findSpaceById(id);
    if (!space) return reply.code(404).send({ error: 'space inválido' });
    const since = Number(req.query.since) || 0;
    const records = pullRecords(id, since);
    const serverNow = Date.now();
    const lastTs = records.length ? records[records.length - 1].updated_at : since;
    return { space_id: id, records, count: records.length, server_now: serverNow, cursor: lastTs };
  });

  // POST /v1/spaces/:id/push  body: { records: [{ kind, id, data, updated_at, deleted_at? }, ...] }
  api.post('/v1/spaces/:id/push', async (req, reply) => {
    const { id } = req.params;
    const space = findSpaceById(id);
    if (!space) return reply.code(404).send({ error: 'space inválido' });
    const records = (req.body || {}).records;
    if (!Array.isArray(records)) return reply.code(400).send({ error: 'body.records deve ser array' });
    if (records.length > 500) return reply.code(400).send({ error: 'max 500 records por push' });
    const written = pushRecords(id, records);
    touchSpace(id);
    return { received: records.length, written, server_now: Date.now() };
  });

  // GET /v1/spaces/:id/info → metadados + estatísticas
  api.get('/v1/spaces/:id/info', async (req, reply) => {
    const { id } = req.params;
    const space = findSpaceById(id);
    if (!space) return reply.code(404).send({ error: 'space inválido' });
    return {
      id: space.id,
      code: space.code,
      name: space.name,
      created_at: space.created_at,
      last_active: space.last_active,
      has_pin: !!space.pin_hash,
      stats: spaceStats(id),
    };
  });

  // Index do prefixo (debug)
  api.get('/', async () => ({
    service: 'lecolista-api',
    base_path: BASE_PATH,
    endpoints: [
      `${BASE_PATH}/v1/health`,
      `${BASE_PATH}/v1/stats`,
      `${BASE_PATH}/v1/price?q=...`,
      `${BASE_PATH}/v1/price/batch`,
      `POST ${BASE_PATH}/v1/spaces`,
      `POST ${BASE_PATH}/v1/spaces/join`,
      `GET  ${BASE_PATH}/v1/spaces/:id/pull?since=TS`,
      `POST ${BASE_PATH}/v1/spaces/:id/push`,
      `GET  ${BASE_PATH}/v1/spaces/:id/info`,
    ],
  }));
}, { prefix: BASE_PATH });

// Healthcheck root (sem prefix) — pro Docker healthcheck do container
app.get('/healthz', async () => ({ ok: true }));

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ port: PORT, cors: CORS_ORIGINS }, 'lecolista-api up');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async () => {
  app.log.info('shutting down...');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
