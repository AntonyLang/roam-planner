import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { readEnv } from '../../app-config';

/** The outbox is committed by SQLite alongside each native mutation, including
 * writes outside REST. Rolled-back writes roll back their outbox too. Delivery is retried
 * with the same identity; PostgreSQL deduplicates before appending Session events. */
@Injectable()
export class AgentJournal implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(private readonly db: DatabaseService) {}
  onModuleInit() {
    if ((process.env.AGENT_RUNTIME ?? 'pi-durable') === 'pi-durable') return;
    this.db.connection.exec(`CREATE TABLE IF NOT EXISTS agent_trip_outbox (
      event_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), trip_id INTEGER NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), delivered_at TEXT);`);
    const tables: Record<string, (r: string) => string> = {
      trips: r => `${r}.id`, days: r => `${r}.trip_id`, places: r => `${r}.trip_id`,
      reservations: r => `${r}.trip_id`, budget_items: r => `${r}.trip_id`, day_notes: r => `${r}.trip_id`,
      accommodations: r => `${r}.trip_id`, agent_conditions: r => `${r}.trip_id`,
      day_accommodations: r => `${r}.trip_id`,
      agent_candidates: r => `${r}.trip_id`, trip_members: r => `${r}.trip_id`,
      budget_settlements: r => `${r}.trip_id`,
      budget_item_members: r => `(SELECT trip_id FROM budget_items WHERE id=${r}.budget_item_id)`,
      budget_item_payers: r => `(SELECT trip_id FROM budget_items WHERE id=${r}.budget_item_id)`,
      day_assignments: r => `(SELECT trip_id FROM days WHERE id=${r}.day_id)`,
      roadtrip_vias: r => `(SELECT trip_id FROM days WHERE id=${r}.day_id)`,
      reservation_endpoints: r => `(SELECT trip_id FROM reservations WHERE id=${r}.reservation_id)`,
      assignment_participants: r => `(SELECT d.trip_id FROM day_assignments a JOIN days d ON d.id=a.day_id WHERE a.id=${r}.assignment_id)`,
      place_tags: r => `(SELECT trip_id FROM places WHERE id=${r}.place_id)`,
    };
    for (const [table, trip] of Object.entries(tables)) {
      const columns = this.db.all<{ name: string }>(`PRAGMA table_info(${table})`).map(c => c.name);
      if (!columns.length) continue;
      // Do not duplicate private bearer tokens into the Agent journal.
      const safe = columns.filter(c => !/token|secret|password/i.test(c));
      const row = (r: string) => `json_object(${safe.map(c => `'${c}',${r}."${c}"`).join(',')})`;
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = operation === 'DELETE' ? 'OLD' : 'NEW';
        const before = operation === 'INSERT' ? 'NULL' : row('OLD');
        const after = operation === 'DELETE' ? 'NULL' : row('NEW');
        this.db.connection.exec(`CREATE TRIGGER IF NOT EXISTS agent_journal_${table}_${operation.toLowerCase()}
          ${operation === 'DELETE' ? 'BEFORE' : 'AFTER'} ${operation} ON ${table} WHEN ${trip(ref)} IS NOT NULL
          BEGIN INSERT INTO agent_trip_outbox(trip_id,payload) VALUES (${trip(ref)},
            json_object('table','${table}','operation','${operation.toLowerCase()}','before',${before},'after',${after})); END;`);
      }
    }
    this.timer = setInterval(() => void this.flush(), 1500);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      const draftRows = this.db.all<{ event_id: string; session_id: string; task_id: string; payload: string }>('SELECT * FROM agent_draft_outbox WHERE delivered_at IS NULL ORDER BY rowid LIMIT 100');
      if (draftRows.length) {
        const delivery = await fetch(readEnv().agent.intelligenceUrl + '/v1/draft-events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ events: draftRows.map(row => ({ ...row, payload: JSON.parse(row.payload) })) }),
        });
        if (delivery.ok) this.db.transaction(() => { for (const row of draftRows) this.db.run("UPDATE agent_draft_outbox SET delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_id=?", row.event_id); });
      }
      const rows = this.db.all<{ event_id: string; trip_id: number; payload: string; created_at: string; source_seq: number }>('SELECT rowid AS source_seq,* FROM agent_trip_outbox WHERE delivered_at IS NULL ORDER BY rowid LIMIT 100');
      if (!rows.length) return;
      const response = await fetch(readEnv().agent.intelligenceUrl + '/v1/trip-events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ events: rows.map(r => ({ ...r, payload: JSON.parse(r.payload) })) }),
      });
      if (!response.ok) return;
      this.db.transaction(() => { for (const r of rows) this.db.run("UPDATE agent_trip_outbox SET delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_id=?", r.event_id); });
    } catch { /* Retain the durable outbox while intelligence is unavailable. */ }
    finally { this.busy = false; }
  }
}
