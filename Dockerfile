# Multi-stage: builda native deps (better-sqlite3) e copia só o necessário.
# Roda nativamente em ARM64 (Raspberry Pi 4).

FROM node:20-alpine AS deps

# better-sqlite3 precisa compilar — instala toolchain
RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && \
    npm rebuild better-sqlite3

# ── Runtime image (slim) ────────────────────────────────────
FROM node:20-alpine AS runtime

# Apenas o runtime do sqlite (não a toolchain de build)
RUN apk add --no-cache sqlite-libs tini wget

WORKDIR /app

# Copy node_modules e source
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Volume pra persistência do SQLite
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/data/lecolista.db \
    TZ=America/Sao_Paulo

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3001/healthz > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
