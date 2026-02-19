/**
 * Database — Single SQLite database with all schemas.
 * WAL mode for concurrent reads/writes.
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { SqliteDatabase } from '../types';

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
-- ═══ SETTINGS ═══
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA cache_size=-64000;
PRAGMA temp_store=MEMORY;
PRAGMA foreign_keys=ON;

-- ═══ SCHEMA VERSION ═══
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- ═══ EVENT LOG (immutable) ═══
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  source      TEXT NOT NULL,
  content     TEXT NOT NULL,
  diff        TEXT,
  file        TEXT,
  metadata    TEXT,
  timestamp   INTEGER NOT NULL,
  processed   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed) WHERE processed = 0;
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_file ON events(file) WHERE file IS NOT NULL;

-- ═══ MEMORY UNITS (projection from events) ═══
CREATE TABLE IF NOT EXISTS memory_units (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  intent          TEXT NOT NULL,
  action          TEXT NOT NULL,
  reason          TEXT,
  impact          TEXT,
  outcome         TEXT DEFAULT 'unknown',
  related_files   TEXT,
  code_snippet    TEXT,
  tags            TEXT,
  timestamp       INTEGER NOT NULL,
  confidence      REAL DEFAULT 0.5,
  importance      REAL DEFAULT 0.5,
  access_count    INTEGER DEFAULT 0,
  last_accessed   INTEGER,
  superseded_by   TEXT,
  is_active       INTEGER DEFAULT 1,
  source_event_id INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mu_active ON memory_units(is_active, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mu_type ON memory_units(type) WHERE is_active = 1;

-- ═══ FULL-TEXT SEARCH ═══
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED, intent, action, reason, impact, tags,
  content='memory_units', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- FTS triggers for auto-sync
CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_units BEGIN
  INSERT INTO memory_fts(rowid, id, intent, action, reason, impact, tags)
  VALUES (new.rowid, new.id, new.intent, new.action, new.reason, new.impact, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_units BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, id, intent, action, reason, impact, tags)
  VALUES ('delete', old.rowid, old.id, old.intent, old.action, old.reason, old.impact, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory_units BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, id, intent, action, reason, impact, tags)
  VALUES ('delete', old.rowid, old.id, old.intent, old.action, old.reason, old.impact, old.tags);
  INSERT INTO memory_fts(rowid, id, intent, action, reason, impact, tags)
  VALUES (new.rowid, new.id, new.intent, new.action, new.reason, new.impact, new.tags);
END;

-- ═══ GRAPH EDGES ═══
CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation  TEXT NOT NULL,
  weight    REAL DEFAULT 1.0,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

-- ═══ USER SIGNALS (learning) ═══
CREATE TABLE IF NOT EXISTS user_signals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL,
  signal     TEXT NOT NULL,
  correction TEXT,
  timestamp  INTEGER NOT NULL
);

-- ═══ RETRIEVAL FEEDBACK ═══
CREATE TABLE IF NOT EXISTS feedback_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL,
  query_hash    TEXT NOT NULL,
  query_type    TEXT,
  search_method TEXT,
  was_useful    INTEGER,
  timestamp     INTEGER NOT NULL
);

-- ═══ PROJECT IDENTITY ═══
CREATE TABLE IF NOT EXISTS identity (
  key        TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ═══ DAILY SUMMARIES ═══
CREATE TABLE IF NOT EXISTS daily_summaries (
  date       TEXT PRIMARY KEY,
  summary    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ═══ ADAPTIVE CONFIG ═══
CREATE TABLE IF NOT EXISTS adaptive_config (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  default_value TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
`;

export class CognitiveDatabase {
  private db: SqliteDatabase;
  private _dbPath: string;

  constructor(storagePath: string) {
    const dataDir = path.join(storagePath, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this._dbPath = path.join(dataDir, 'cognitive.db');

    // Support for pkg (standalone binaries) where native module is next to executable
    const nativeBinding = (process as any).pkg
      ? path.join(path.dirname(process.execPath), 'better_sqlite3.node')
      : undefined;

    this.db = new Database(this._dbPath, { nativeBinding });
    this.initialize();
  }

  private initialize(): void {
    // Execute pragmas first (they can't be in a transaction)
    this.db.pragma('journal_mode=WAL');
    this.db.pragma('synchronous=NORMAL');
    this.db.pragma('cache_size=-64000');
    this.db.pragma('temp_store=MEMORY');
    this.db.pragma('foreign_keys=ON');

    // Check schema version
    const hasVersionTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get();

    if (!hasVersionTable) {
      // First time — create all tables
      this.db.exec(SCHEMA_SQL);
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else {
      const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
        | { version: number }
        | undefined;
      if (row && row.version < SCHEMA_VERSION) {
        this.migrate(row.version);
      }
    }
  }

  private migrate(fromVersion: number): void {
    // Future migrations go here
    // if (fromVersion < 2) { ... }
    this.db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }

  /** Get the raw database connection for direct queries */
  get connection(): SqliteDatabase {
    return this.db;
  }

  /** Get database file path */
  get dbPath(): string {
    return this._dbPath;
  }

  /** Get database size in bytes */
  get sizeBytes(): number {
    try {
      const stats = fs.statSync(this._dbPath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /** Checkpoint WAL to main database */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /** Close the database connection */
  close(): void {
    this.checkpoint();
    this.db.close();
  }
}
