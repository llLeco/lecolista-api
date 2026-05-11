# lecolista-api

API de lookup de preços pro **HSH Mercado** (`lista.devbyle.co`). Scrapeia
Mercado Livre via HTML parsing, cacheia em SQLite, expõe via REST.

```
Cliente PWA (lista.devbyle.co)
    ↓ HTTPS (mesmo tunnel, mesmo host)
Cloudflare Tunnel
    ↓
Pi:80 → Traefik
    ├─ Host(lista.devbyle.co)                  → web container :80
    └─ Host(lista.devbyle.co) && PathPrefix(/api) → api container :3001
                                                    ↓
                                              Node + Fastify (BASE_PATH=/api)
                                                    ↓ scrape on miss (TTL 24h)
                                              mercado.carrefour.com.br
```

**Mesma origem que o front** — front faz `fetch('/api/v1/price?...')` direto,
sem CORS, sem subdomínio extra, sem rota Cloudflare adicional.

## Endpoints

Em produção, prefixo `/api` (configurável via env `BASE_PATH`).

| Método | Caminho | Descrição |
|---|---|---|
| GET | `/api/v1/health` | Healthcheck + uptime |
| GET | `/api/v1/stats` | Contadores de uso + 20 lookups recentes |
| GET | `/api/v1/price?q=leite&refresh=0` | Lookup do menor preço (cached 24h) |
| POST | `/api/v1/price/batch` | `{ queries: ["leite","pão"] }` — lookup em lote (max 25) |
| GET | `/healthz` | Healthcheck pra Docker (sem prefix, sem auth) |

### Resposta `/v1/price`

```json
{
  "found": true,
  "price": 7.49,
  "currency": "BRL",
  "title": "Leite Integral Italac 1l",
  "link": "https://produto.mercadolivre.com.br/...",
  "thumbnail": "https://http2.mlstatic.com/...",
  "source": "ml",
  "cached": false,
  "fetchedAt": 1747000000000,
  "query": "leite"
}
```

## Local

```bash
npm install
npm run dev   # node --watch src/server.js
curl 'http://localhost:3001/v1/price?q=leite'
```

## Deploy (Pi via Coolify)

Já configurado em `docker-compose.coolify.yml`:
- `node:20-alpine` ARM64
- Volume `lecolista-api-data` pra persistir SQLite
- CORS restrito a `https://lista.devbyle.co`
- Rate limit 60 req/min por IP

## Cache

- TTL 24h por query (normalizada: lowercase + sem acentos + espaços únicos)
- Refresh forçado: `?refresh=1`
- Misses + erros são registrados na tabela `prices` mesmo assim (com `found=0`),
  então re-tentar a mesma query antes de 24h não martela o ML.

## Limitações

- Apenas Mercado Livre por ora (Amazon tem anti-bot agressivo)
- ML pode mudar HTML — scraper tem fallback (JSON-LD → DOM Andes), mas pode
  precisar de ajuste ocasional
- Pra produção séria, considerar Mercado Livre Affiliate API (oficial, gratuita,
  paga comissão por cliques)
