// SQLite cache de preços. better-sqlite3 é síncrono, super rápido.
// Schema é criado on-startup se não existir.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || '/data/lecolista.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS prices (
    query        TEXT PRIMARY KEY,
    found        INTEGER NOT NULL DEFAULT 0,
    price        REAL,
    currency     TEXT DEFAULT 'BRL',
    title        TEXT,
    link         TEXT,
    thumbnail    TEXT,
    source       TEXT,
    fetched_at   INTEGER NOT NULL,
    error        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_prices_fetched ON prices(fetched_at);

  CREATE TABLE IF NOT EXISTS stats (
    key          TEXT PRIMARY KEY,
    value        INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO stats (key, value, updated_at) VALUES
    ('requests_total', 0, strftime('%s','now')*1000),
    ('cache_hits',     0, strftime('%s','now')*1000),
    ('cache_misses',   0, strftime('%s','now')*1000),
    ('scrape_errors',  0, strftime('%s','now')*1000);
`);

export const TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function normalize(q) {
  return String(q || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const sel  = db.prepare('SELECT * FROM prices WHERE query = ?');
const upd  = db.prepare(`
  INSERT INTO prices (query, found, price, currency, title, link, thumbnail, source, fetched_at, error)
  VALUES (@query, @found, @price, @currency, @title, @link, @thumbnail, @source, @fetched_at, @error)
  ON CONFLICT(query) DO UPDATE SET
    found      = excluded.found,
    price      = excluded.price,
    currency   = excluded.currency,
    title      = excluded.title,
    link       = excluded.link,
    thumbnail  = excluded.thumbnail,
    source     = excluded.source,
    fetched_at = excluded.fetched_at,
    error      = excluded.error
`);

const incStat = db.prepare(`UPDATE stats SET value = value + 1, updated_at = ? WHERE key = ?`);

export function getCached(query, { maxAge = TTL_MS } = {}) {
  const row = sel.get(normalize(query));
  if (!row) return null;
  if (Date.now() - row.fetched_at > maxAge) return null;
  return row;
}

export function getRaw(query) {
  return sel.get(normalize(query));
}

export function savePrice(query, data) {
  upd.run({
    query: normalize(query),
    found: data.found ? 1 : 0,
    price: data.price ?? null,
    currency: data.currency ?? 'BRL',
    title: data.title ?? null,
    link: data.link ?? null,
    thumbnail: data.thumbnail ?? null,
    source: data.source ?? null,
    fetched_at: Date.now(),
    error: data.error ?? null,
  });
}

export function bumpStat(key) {
  try { incStat.run(Date.now(), key); } catch {}
}

export function getStats() {
  return Object.fromEntries(db.prepare('SELECT key, value, updated_at FROM stats').all().map((r) => [r.key, r]));
}

export function getRecent(limit = 20) {
  return db.prepare('SELECT query, found, price, title, source, fetched_at FROM prices ORDER BY fetched_at DESC LIMIT ?').all(limit);
}
