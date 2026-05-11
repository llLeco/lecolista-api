// Schema + queries pra sync multi-device.
// Cada "space" = um grupo família. Cada registro tem space_id + updated_at + deleted_at.
// Sync = last-write-wins por updated_at. Delete = soft (deleted_at != null) pra propagar.

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

let _db;
export function initSyncDB(path) {
  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    -- "Grupo família". Code é o convite (4-4 chars). Pin opcional (hash SHA-256).
    CREATE TABLE IF NOT EXISTS spaces (
      id            TEXT PRIMARY KEY,            -- uuid
      code          TEXT NOT NULL UNIQUE,        -- ABCD-1234 (convite)
      name          TEXT,                        -- ex: "Casa dos Lemos"
      pin_hash      TEXT,                        -- opcional
      created_at    INTEGER NOT NULL,
      last_active   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spaces_code ON spaces(code);

    -- Tabelas sync-able. Todas têm: space_id, id (uuid client), updated_at, deleted_at, json.
    -- json = payload completo do registro (cliente envia/recebe inteiro).
    -- Simplifica schema: backend só precisa garantir ordenação por updated_at.
    CREATE TABLE IF NOT EXISTS sync_records (
      space_id      TEXT NOT NULL,
      kind          TEXT NOT NULL,               -- 'items' | 'family' | 'inventory' | 'recurring' | 'prices' | 'history'
      id            TEXT NOT NULL,               -- uuid do registro no cliente
      data          TEXT NOT NULL,               -- json do registro
      updated_at    INTEGER NOT NULL,
      deleted_at    INTEGER,
      PRIMARY KEY (space_id, kind, id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_updated ON sync_records(space_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_sync_kind ON sync_records(space_id, kind);
  `);
  return _db;
}

export function db() { return _db; }

// Gera code de convite memorável: 4 letras + 4 dígitos (sem ambíguos: 0/O/1/I/L)
const SAFE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode() {
  const buf = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += SAFE_CHARS[buf[i] % SAFE_CHARS.length];
    if (i === 3) code += '-';
  }
  return code;
}

export function createSpace(name = null, pinHash = null) {
  // Tenta gerar code único (em 5 tentativas)
  const stmt = _db.prepare('INSERT INTO spaces (id, code, name, pin_hash, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?)');
  const existsStmt = _db.prepare('SELECT 1 FROM spaces WHERE code = ?');
  let id, code;
  for (let attempt = 0; attempt < 5; attempt++) {
    id = randomBytes(16).toString('hex');
    code = randomCode();
    if (!existsStmt.get(code)) break;
  }
  const now = Date.now();
  stmt.run(id, code, name, pinHash, now, now);
  return { id, code, name, pinHash, created_at: now, last_active: now };
}

export function findSpaceByCode(code) {
  return _db.prepare('SELECT * FROM spaces WHERE code = ?').get(String(code || '').toUpperCase().trim());
}

export function findSpaceById(id) {
  return _db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
}

export function touchSpace(id) {
  _db.prepare('UPDATE spaces SET last_active = ? WHERE id = ?').run(Date.now(), id);
}

// Bulk upsert de registros pro sync push.
// Cada record: { kind, id, data (obj), updated_at, deleted_at? }
const upsertStmt = () => _db.prepare(`
  INSERT INTO sync_records (space_id, kind, id, data, updated_at, deleted_at)
  VALUES (@space_id, @kind, @id, @data, @updated_at, @deleted_at)
  ON CONFLICT(space_id, kind, id) DO UPDATE SET
    data       = excluded.data,
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at
  WHERE excluded.updated_at >= sync_records.updated_at
`);

export function pushRecords(spaceId, records) {
  const stmt = upsertStmt();
  const tx = _db.transaction((recs) => {
    let written = 0;
    for (const r of recs) {
      const res = stmt.run({
        space_id: spaceId,
        kind: r.kind,
        id: r.id,
        data: JSON.stringify(r.data || null),
        updated_at: r.updated_at || Date.now(),
        deleted_at: r.deleted_at || null,
      });
      if (res.changes > 0) written++;
    }
    return written;
  });
  return tx(records);
}

// Pull de mudanças desde `since` (timestamp ms). Inclui deleted.
export function pullRecords(spaceId, since = 0, limit = 1000) {
  return _db.prepare(`
    SELECT kind, id, data, updated_at, deleted_at
    FROM sync_records
    WHERE space_id = ? AND updated_at > ?
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(spaceId, since, limit).map((r) => ({
    kind: r.kind,
    id: r.id,
    data: r.data ? JSON.parse(r.data) : null,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  }));
}

export function spaceStats(spaceId) {
  const counts = _db.prepare(`
    SELECT kind, COUNT(*) as n, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) as alive
    FROM sync_records WHERE space_id = ? GROUP BY kind
  `).all(spaceId);
  return Object.fromEntries(counts.map((c) => [c.kind, { total: c.n, alive: c.alive }]));
}
