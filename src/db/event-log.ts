/**
 * Event Log — Immutable append-only event store.
 * All brain inputs are recorded here first.
 */
import type { BrainEvent, SqliteDatabase } from '../types';
import type { CognitiveDatabase } from './database';

export class EventLog {
    private db: SqliteDatabase;
    private appendStmt: ReturnType<SqliteDatabase['prepare']>;
    private markProcessedStmt: ReturnType<SqliteDatabase['prepare']>;

    constructor(database: CognitiveDatabase) {
        this.db = database.connection;

        this.appendStmt = this.db.prepare(`
      INSERT INTO events (event_type, source, content, diff, file, metadata, timestamp, processed)
      VALUES (@eventType, @source, @content, @diff, @file, @metadata, @timestamp, 0)
    `);

        this.markProcessedStmt = this.db.prepare(`
      UPDATE events SET processed = 1 WHERE id = ?
    `);
    }

    /** Append a new event (immutable — never modified after insert) */
    append(event: BrainEvent): number {
        const result = this.appendStmt.run({
            eventType: event.eventType,
            source: event.source,
            content: event.content,
            diff: event.diff || null,
            file: event.file || null,
            metadata: event.metadata ? JSON.stringify(event.metadata) : null,
            timestamp: event.timestamp,
        });

        return Number(result.lastInsertRowid);
    }

    /** Append multiple events in a single transaction */
    appendBatch(events: BrainEvent[]): number[] {
        const ids: number[] = [];
        const tx = this.db.transaction(() => {
            for (const event of events) {
                ids.push(this.append(event));
            }
        });
        tx();
        return ids;
    }

    /** Mark an event as processed */
    markProcessed(eventId: number): void {
        this.markProcessedStmt.run(eventId);
    }

    /** Get unprocessed events (oldest first) */
    getUnprocessed(limit: number = 100): BrainEvent[] {
        const rows = this.db
            .prepare('SELECT * FROM events WHERE processed = 0 ORDER BY timestamp ASC LIMIT ?')
            .all(limit) as any[];

        return rows.map(this.rowToEvent);
    }

    /** Get events by file */
    getByFile(filePath: string, limit: number = 50): BrainEvent[] {
        const rows = this.db
            .prepare('SELECT * FROM events WHERE file = ? ORDER BY timestamp DESC LIMIT ?')
            .all(filePath, limit) as any[];

        return rows.map(this.rowToEvent);
    }

    /** Get recent events */
    getRecent(limit: number = 50): BrainEvent[] {
        const rows = this.db
            .prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?')
            .all(limit) as any[];

        return rows.map(this.rowToEvent);
    }

    /** Total event count */
    count(): number {
        const row = this.db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number };
        return row.cnt;
    }

    private rowToEvent(row: any): BrainEvent {
        return {
            id: row.id,
            eventType: row.event_type,
            source: row.source,
            content: row.content,
            diff: row.diff || undefined,
            file: row.file || undefined,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
            timestamp: row.timestamp,
            processed: row.processed === 1,
        };
    }
}
