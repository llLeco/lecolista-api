// LecoLista API · Fastify + SQLite cache + scraping ML
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { searchPrice as searchCarrefour } from './scrapers/carrefour.js';
import { searchPrice as searchBuscape } from './scrapers/buscape.js';

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
// Prefix opcional — quando rodando atrás de Traefik com PathPrefix(/api),
// todas as rotas viram /api/v1/...  Mesma origem do front, sem CORS.
const BASE_PATH = process.env.BASE_PATH || '/api';
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

  // Index do prefixo (debug)
  api.get('/', async () => ({
    service: 'lecolista-api',
    base_path: BASE_PATH,
    endpoints: [`${BASE_PATH}/v1/health`, `${BASE_PATH}/v1/stats`, `${BASE_PATH}/v1/price?q=...`, `${BASE_PATH}/v1/price/batch`],
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
