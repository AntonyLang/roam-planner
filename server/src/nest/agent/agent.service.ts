import { HttpException, Injectable, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { agentSaveSchema, agentPlanSchema, gcj02ToWgs84, type AgentSave } from '@trek/shared';
import { DatabaseService } from '../database/database.service';
import { PlacesService } from '../places/places.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { PermissionsService } from '../permissions/permissions.service';
import { DayNotesService } from '../day-notes/day-notes.service';
import { BudgetService } from '../budget/budget.service';
import { AccommodationsService } from '../accommodations/accommodations.service';
import { z } from 'zod';
import { readEnv } from '../../app-config';
import {plannedTransport} from './planned-transport';
import {ReservationsService} from '../reservations/reservations.service';
import type {DayAccommodation} from '../accommodations/accommodations.service';

const nativeOperations = z.array(z.discriminatedUnion('name', [
  z.object({ name: z.literal('create_day_note'), arguments: z.object({ tripId: z.number().int().positive(), dayId: z.number().int().positive(), text: z.string().min(1).max(500), time: z.string().max(250).optional(), icon: z.string().max(64).optional(), color: z.string().max(64).nullable().optional(), sort_order: z.number().optional() }).strict() }),
  z.object({ name: z.literal('create_budget_item'), arguments: z.object({ tripId: z.number().int().positive(), name: z.string().min(1).max(200), total_price: z.number().nonnegative(), currency: z.string().max(10).nullable().optional(), expense_date: z.string().max(40).nullable().optional(), category: z.string().max(100).optional(), member_ids: z.array(z.number()).max(0), note: z.string().max(500).optional(), place_id: z.number().int().positive().optional() }).strict() }),
  z.object({ name: z.literal('create_accommodation'), arguments: z.object({ tripId: z.number().int().positive(), place_id: z.number().int().positive().optional(), place_ref: z.string().min(1).optional(), start_day_id: z.number().int().positive(), end_day_id: z.number().int().positive(), check_in: z.string().max(10).optional(), check_in_end: z.string().max(10).optional(), check_out: z.string().max(10).optional(), notes: z.string().max(1000).optional() }).strict().refine(a => !!a.place_id !== !!a.place_ref, 'Choose one accommodation place reference') }),
])).max(100);

function canonical(value: unknown): string {
  if (typeof value === 'number') {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    return 'n' + bytes.toString('hex');
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

@Injectable()
export class AgentService implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly places: PlacesService,
    private readonly assignments: AssignmentsService, private readonly permissions: PermissionsService,
    private readonly notes?: DayNotesService, private readonly budget?: BudgetService,
    private readonly accommodations?: AccommodationsService, private readonly reservations?: ReservationsService) {}

  onModuleInit(): void {
    // Additive, repeatable domain migration; does not change upstream tables.
    this.db.connection.exec(`
      CREATE TABLE IF NOT EXISTS agent_conditions (trip_id INTEGER PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_candidates (candidate_id TEXT NOT NULL, version INTEGER NOT NULL, trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE, payload TEXT NOT NULL, adopted_at TEXT, PRIMARY KEY(candidate_id, version));
      CREATE TABLE IF NOT EXISTS agent_operations (operation_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, signature TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_confirmations (trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,user_id INTEGER NOT NULL,key TEXT NOT NULL,PRIMARY KEY(trip_id,user_id,key));
      CREATE TABLE IF NOT EXISTS agent_map_routes (trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,key TEXT NOT NULL,payload TEXT NOT NULL,queried_at INTEGER NOT NULL,PRIMARY KEY(trip_id,key));
    `);
  }

  private access(tripId: number, userId: number, write = false) {
    const trip = this.db.canAccessTrip(tripId, userId);
    if (!trip) throw new HttpException({ error: 'Trip not found' }, 404);
    const user = this.db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
    if (write && !this.permissions.checkPermission('day_edit', user?.role || 'user', trip.user_id, userId, trip.user_id !== userId)) throw new HttpException({ error: 'Edit permission required' }, 403);
    return trip;
  }

  snapshot(tripId: number, userId: number) {
    this.access(tripId, userId);
    return this.db.transaction(() => {
      const trip = this.db.get<Record<string, unknown>>('SELECT * FROM trips WHERE id = ?', tripId);
      const days = this.db.all('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number', tripId);
      const places = this.db.all('SELECT * FROM places WHERE trip_id = ? ORDER BY id', tripId);
      const assignments = this.db.all('SELECT a.* FROM day_assignments a JOIN days d ON d.id = a.day_id WHERE d.trip_id = ? ORDER BY a.day_id, a.order_index, a.id', tripId);
      const related: Record<string, unknown> = {};
      for (const table of ['reservations', 'budget_items', 'budget_settlements', 'day_notes', 'trip_members']) {
        related[table] = this.db.all(`SELECT * FROM ${table} WHERE trip_id = ? ORDER BY id`, tripId);
      }
      related.assignment_participants = this.db.all('SELECT ap.* FROM assignment_participants ap JOIN day_assignments a ON a.id=ap.assignment_id JOIN days d ON d.id=a.day_id WHERE d.trip_id=? ORDER BY ap.assignment_id,ap.user_id', tripId);
      for (const table of ['budget_item_members', 'budget_item_payers']) related[table] = this.db.all(`SELECT b.* FROM ${table} b JOIN budget_items i ON i.id=b.budget_item_id WHERE i.trip_id=? ORDER BY b.id`, tripId);
      for (const table of ['budget_item_members', 'budget_item_payers', 'budget_settlements']) if (!(related[table] as unknown[]).length) delete related[table];
      related.reservation_endpoints = this.db.all('SELECT e.* FROM reservation_endpoints e JOIN reservations r ON r.id=e.reservation_id WHERE r.trip_id=? ORDER BY e.id', tripId);
      related.roadtrip_vias = this.db.all('SELECT v.* FROM roadtrip_vias v JOIN days d ON d.id=v.day_id WHERE d.trip_id=? ORDER BY v.id', tripId);
      related.place_tags = this.db.all('SELECT pt.place_id,pt.tag_id FROM place_tags pt JOIN places p ON p.id=pt.place_id WHERE p.trip_id=? ORDER BY pt.place_id,pt.tag_id', tripId);
      // Include accommodation records if the upstream schema supports them.
      for (const table of ['accommodations', 'day_accommodations']) {
        const columns = this.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
        if (columns.some(c => c.name === 'trip_id')) related[table] = this.db.all(`SELECT * FROM ${table} WHERE trip_id = ? ORDER BY id`, tripId);
        else if (columns.some(c => c.name === 'day_id')) related[table] = this.db.all(`SELECT a.* FROM ${table} a JOIN days d ON d.id = a.day_id WHERE d.trip_id = ? ORDER BY a.day_id`, tripId);
      }
      const row = this.db.get<{ content: string }>('SELECT content FROM agent_conditions WHERE trip_id = ?', tripId);
      const content = { trip, days, places, assignments, related, requirements: row ? JSON.parse(row.content) : {} };
      const journal = this.db.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='agent_trip_outbox'");
      const journalCursor = journal ? this.db.get<{ cursor: number }>('SELECT COALESCE(MAX(rowid),0) AS cursor FROM agent_trip_outbox WHERE trip_id=?', tripId)!.cursor : null;
      return { ...content, revision: hash(content), journal_cursor: journalCursor, retrieved_at: new Date().toISOString() };
    });
  }
  draftAccess(tripId: number, userId: number) { this.access(tripId, userId, true); }
  confirmations(tripId:number,userId:number){
    this.access(tripId,userId);
    return {keys:this.db.all<{key:string}>('SELECT key FROM agent_confirmations WHERE trip_id=? AND user_id=?',tripId,userId).map(row=>row.key)};
  }
  confirm(tripId:number,userId:number,key:string){
    this.access(tripId,userId);
    this.db.run('INSERT OR IGNORE INTO agent_confirmations VALUES (?,?,?)',tripId,userId,key);
    return {confirmed:true};
  }
  async mapRoute(tripId: number, userId: number, query: {
    origin: { latitude: number; longitude: number; coordinate_system: 'WGS84' };
    destination: { latitude: number; longitude: number; coordinate_system: 'WGS84' };
    mode: 'walking'|'transit'|'driving';
  }) {
    this.access(tripId, userId);
    const key=hash(query);
    const cached=this.db.get<{payload:string}>('SELECT payload FROM agent_map_routes WHERE trip_id=? AND key=? AND queried_at>?',tripId,key,Date.now()-86400000);
    if(cached)return JSON.parse(cached.payload);
    const response = await fetch(readEnv().agent.externalSourcesUrl.replace(/\/$/,'') + '/api/v1/sources/routes/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(25000),
    });
    const body = await response.json() as {data?:{result?:{geometry?:{coordinates?:number[][][]}}};error?:{message:string}};
    if (!response.ok || body.error) throw new HttpException(body.error?.message ?? '路线查询暂时不可用', 502);
    if(body.data?.result?.geometry?.coordinates?.length)this.db.run('INSERT INTO agent_map_routes VALUES (?,?,?,?) ON CONFLICT(trip_id,key) DO UPDATE SET payload=excluded.payload,queried_at=excluded.queried_at',tripId,key,JSON.stringify(body.data),Date.now());
    return body.data;
  }

  conditions(tripId: number, userId: number, requirements: Record<string, unknown>) {
    this.access(tripId, userId, true);
    this.db.run('INSERT INTO agent_conditions(trip_id, content) VALUES (?, ?) ON CONFLICT(trip_id) DO UPDATE SET content = excluded.content', tripId, JSON.stringify(requirements));
    return this.snapshot(tripId, userId);
  }

  operation<T>(operationId: string, userId: number, payload: unknown, execute: () => T): T {
    return this.db.transaction(() => {
      const signature = hash(payload);
      const existing = this.db.get<{ user_id: number; signature: string; result: string }>('SELECT * FROM agent_operations WHERE operation_id = ?', operationId);
      if (existing) {
        if (existing.user_id !== userId || existing.signature !== signature) throw new HttpException({ error: 'Operation identity conflicts with payload' }, 409);
        return JSON.parse(existing.result);
      }
      const journal = this.db.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='agent_trip_outbox'");
      const cursor = journal ? this.db.get<{ cursor: number }>('SELECT COALESCE(MAX(rowid),0) AS cursor FROM agent_trip_outbox')!.cursor : null;
      const result = execute();
      // Mark the same transaction's writes before delivery. Adoption must be
      // replayable without being mistaken for a new manual edit/replan request.
      if (cursor !== null) this.db.run("UPDATE agent_trip_outbox SET payload=json_set(payload,'$.origin','agent','$.operation_id',?) WHERE rowid>?", operationId, cursor);
      this.db.run('INSERT INTO agent_operations VALUES (?, ?, ?, ?)', operationId, userId, signature, JSON.stringify(result));
      return result;
    });
  }

  save(userId: number, raw: AgentSave) {
    const data = agentSaveSchema.parse(raw);
    this.access(data.trip_id, userId, true);
    return this.operation(data.operation_id, userId, data, () => {
      const snapshot = this.snapshot(data.trip_id, userId);
      if (snapshot.revision !== data.base_revision) throw new HttpException({ error: 'TRIP_REVISION_CONFLICT', current_revision: snapshot.revision }, 409);
      this.validateScope(data, snapshot);
      this.validateNativeOperations(data, userId);
      if (data.runtime !== 'pi-durable') {
        if (data.review && data.review.plan_hash !== hash(data.plan)) throw new HttpException({ error: 'REVIEW_CONTENT_CONFLICT' }, 409);
        if (data.plan.constraints.some(c => c.kind === 'hard' && c.status !== 'satisfied')) throw new HttpException({ error: 'Hard constraint is violated or unknown' }, 422);
      }
      const saved = this.db.get('SELECT 1 FROM agent_candidates WHERE candidate_id = ? AND version = ?', data.candidate_id, data.candidate_version);
      if (saved) throw new HttpException({ error: 'Candidate version already exists' }, 409);
      this.db.run('INSERT INTO agent_candidates(candidate_id, version, trip_id, payload) VALUES (?, ?, ?, ?)', data.candidate_id, data.candidate_version, data.trip_id, JSON.stringify(data));
      return { candidate_id: data.candidate_id, candidate_version: data.candidate_version, trip_id: data.trip_id, status: 'saved', plan: data.plan, review: data.review };
    });
  }

  validateScope(data: Pick<AgentSave, 'plan' | 'approved_unlocks'>, snapshot: ReturnType<AgentService['snapshot']>) {
    const days = snapshot.days as { id: number; day_number: number }[];
    const rows = snapshot.assignments as { id: number; day_id: number; accommodation_id: number | null; reservation_status: string; order_index: number }[];
    const reservations = snapshot.related.reservations as { id: number; assignment_id: number | null; place_id: number | null; day_id: number | null; status: string }[];
    const configuredLocks = Array.isArray(snapshot.requirements.locked_assignment_ids) ? snapshot.requirements.locked_assignment_ids : [];
    const allReplaced = new Set(data.plan.scope.segments.flatMap(s => s.replace_assignment_ids));
    for (const segment of data.plan.scope.segments) {
      if (!days.some(d => d.id === segment.day_id && d.day_number === segment.day_number)) throw new HttpException({ error: 'Scope day does not belong to trip' }, 422);
      const dayRows = rows.filter(r => r.day_id === segment.day_id);
      const positions = segment.replace_assignment_ids.map(id => dayRows.findIndex(r => r.id === id)).sort((a, b) => a - b);
      if (positions.some(p => p < 0) || positions.some((p, i) => i > 0 && p !== positions[i - 1]! + 1)) throw new HttpException({ error: 'Scope must identify a contiguous segment of this day' }, 422);
      const anchor = segment.insert_after_assignment_id;
      if (anchor !== null && allReplaced.has(anchor)) throw new HttpException({ error: 'Scope anchors must be outside all replaced segments' }, 422);
      if (anchor !== null && !dayRows.some(r => r.id === anchor)) throw new HttpException({ error: 'Insertion anchor is outside this day' }, 422);
      if (positions.length > 0) {
        const previous = dayRows[positions[0]! - 1]?.id ?? null;
        if (anchor !== previous) throw new HttpException({ error: 'Replacement anchor must be immediately before the segment' }, 422);
      }
      for (const id of segment.replace_assignment_ids) {
        const row = dayRows.find(r => r.id === id)!;
        const booked = row.accommodation_id !== null || row.reservation_status === 'confirmed' || reservations.some(r => r.status === 'confirmed' && r.assignment_id === id);
        if ((booked || configuredLocks.includes(id)) && !data.approved_unlocks.includes('assignment:' + id)) throw new HttpException({ error: 'LOCKED_ASSIGNMENT', assignment_id: id }, 422);
      }
    }
    for (const activity of data.plan.activities) {
      if (activity.existing_place_id && !(snapshot.places as { id: number }[]).some(p => p.id === activity.existing_place_id)) throw new HttpException({ error: 'Place does not belong to trip' }, 422);
    }
  }

  validateNativeOperations(data: Pick<AgentSave, 'plan' | 'trip_id'>, userId: number) {
    const operations = nativeOperations.parse(data.plan.extensions.native_operations ?? []);
    const dayIds = new Set(data.plan.scope.segments.map(s => s.day_id));
    for (const operation of operations) {
      const args = operation.arguments;
      if (args.tripId !== data.trip_id) throw new HttpException('Native operation outside trip', 422);
      if ('dayId' in args && !dayIds.has(args.dayId)) throw new HttpException('Note outside approved days', 422);
      if ('start_day_id' in args && (!dayIds.has(args.start_day_id) || !dayIds.has(args.end_day_id))) throw new HttpException('Accommodation outside approved days', 422);
      if ('place_id' in args && args.place_id && !this.db.get('SELECT id FROM places WHERE id=? AND trip_id=?', args.place_id, data.trip_id)) throw new HttpException('Place outside trip', 422);
      if (operation.name === 'create_accommodation') {
        const a = operation.arguments;
        const target = a.place_ref ? data.plan.activities.find(p => p.ref === a.place_ref) : undefined;
        if (a.place_ref && (!target || target.latitude == null || target.longitude == null)) throw new HttpException('Accommodation needs a located draft place reference', 422);
        const errors = this.accommodations?.validateAccommodationRefs(data.trip_id, a.place_id, a.start_day_id, a.end_day_id);
        if (!errors || errors.length) throw new HttpException('Invalid accommodation references', 422);
      }
      if (operation.name === 'create_budget_item') {
        const trip = this.access(data.trip_id, userId, true);
        const user = this.db.get<{ role: string }>('SELECT role FROM users WHERE id=?', userId);
        if (!this.permissions.checkPermission('budget_edit', user?.role || 'user', trip.user_id, userId, trip.user_id !== userId)) throw new HttpException('Budget edit permission required', 403);
      }
    }
    return operations;
  }

  list(tripId: number, userId: number) {
    this.access(tripId, userId);
    return this.db.all<{ payload: string; adopted_at: string | null }>('SELECT payload, adopted_at FROM agent_candidates WHERE trip_id = ? ORDER BY rowid DESC', tripId)
      .map(row => ({ ...JSON.parse(row.payload), adopted_at: row.adopted_at }));
  }

  get(candidateId: string, version: number, userId: number) {
    const row = this.db.get<{ payload: string; adopted_at: string | null }>('SELECT payload, adopted_at FROM agent_candidates WHERE candidate_id = ? AND version = ?', candidateId, version);
    if (!row) throw new HttpException({ error: 'Candidate not found' }, 404);
    const value = JSON.parse(row.payload) as AgentSave;
    this.access(value.trip_id, userId);
    return { ...value, adopted_at: row.adopted_at };
  }

  adoptionAssignments(candidateId: string, version: number, userId: number) {
    const candidate = this.get(candidateId, version, userId);
    const receipt = this.db.get<{ result: string }>(`SELECT result FROM agent_operations
      WHERE user_id=? AND signature=? AND json_type(result,'$.assignment_ids')='array' LIMIT 1`,
    userId, hash({ action: 'adopt', candidateId, version }));
    if (!candidate.adopted_at || !receipt) throw new HttpException({ error: 'ADOPTION_RECEIPT_MISSING' }, 409);
    const result = JSON.parse(receipt.result);
    if (result.trip_id !== candidate.trip_id || result.candidate_id !== candidateId || result.candidate_version !== version)
      throw new HttpException({ error: 'ADOPTION_RECEIPT_CONFLICT' }, 409);
    return { candidate, assignmentIds: z.array(z.number().int().positive()).parse(result.assignment_ids) };
  }

  adopt(candidateId: string, version: number, operationId: string, userId: number) {
    const data = this.get(candidateId, version, userId);
    this.access(data.trip_id, userId, true);
    const replay = this.db.get('SELECT 1 FROM agent_operations WHERE operation_id=?', operationId);
    const result = this.operation(operationId, userId, { action: 'adopt', candidateId, version }, () => {
      const current = this.get(candidateId, version, userId);
      if (current.adopted_at) return { candidate_id: candidateId, candidate_version: version, trip_id: data.trip_id, status: 'adopted', adopted_at: current.adopted_at };
      const snapshot = this.snapshot(data.trip_id, userId);
      if (snapshot.revision !== data.base_revision) throw new HttpException({ error: 'TRIP_REVISION_CONFLICT' }, 409);
      this.validateScope(data, snapshot);
      const plan = agentPlanSchema.parse(data.plan);
      const operations = this.validateNativeOperations(data, userId);
      const replacedIds = new Set(plan.scope.segments.flatMap(s => s.replace_assignment_ids));
      const plannedCosts = new Map<number, { cost: number; currency: string }>();
      for (const activity of plan.activities) {
        if (!activity.existing_place_id || activity.cost == null) continue;
        const prior = plannedCosts.get(activity.existing_place_id);
        if (prior && (prior.cost !== activity.cost || prior.currency !== activity.currency))
          throw new HttpException({ error: 'CONFLICTING_PLACE_COSTS', place_id: activity.existing_place_id,
            message: '同一旅程地点被多个活动引用时，费用和币种须一致；不同活动费用请使用独立地点。' }, 422);
        plannedCosts.set(activity.existing_place_id, { cost: activity.cost, currency: activity.currency });
      }
      for (const [placeId, planned] of plannedCosts) {
        const place = this.places.get(String(data.trip_id), String(placeId))!;
        if (place.price === planned.cost && place.currency === planned.currency) continue;
        const shared = this.db.all<{ id: number }>('SELECT id FROM day_assignments WHERE place_id=?', place.id)
          .some(row => !replacedIds.has(row.id));
        if (shared) throw new HttpException({ error: 'SHARED_PLACE_COST', place_id: place.id,
          message: '费用属于旅程地点；该地点还被修订范围外的日程引用，请为本次活动使用独立地点或明确修改全部引用。' }, 422);
        this.places.updatePlannedCost(String(data.trip_id), String(place.id), planned.cost, planned.currency);
      }
      const ids: number[] = [];
      const placeRefs = new Map<string, number>();
      for (const segment of plan.scope.segments) {
        const day = { id: segment.day_id };
        const old = this.db.all<{ id: number; place_id: number; located: number }>('SELECT a.id,a.place_id,(p.lat IS NOT NULL AND p.lng IS NOT NULL) AS located FROM day_assignments a JOIN places p ON p.id=a.place_id WHERE a.day_id = ? ORDER BY a.order_index,a.created_at,a.id', day.id);
        const removed = new Set(segment.replace_assignment_ids);
        const preserved = old.filter(a => !removed.has(a.id)).map(a => a.id);
        const insertion = segment.insert_after_assignment_id === null ? 0 : preserved.indexOf(segment.insert_after_assignment_id) + 1;
        const activities = plan.activities.filter(a => a.scope_ref === segment.ref);
        const reusable = new Map<string, number>(); const reusedIds = new Set<number>();
        for (const activity of activities) {
          const row = old.find(a => removed.has(a.id) && a.place_id === activity.existing_place_id && !reusedIds.has(a.id));
          if (row) { reusable.set(activity.ref, row.id); reusedIds.add(row.id); }
        }
        segment.replace_assignment_ids.filter(id => !reusedIds.has(id)).forEach(id => this.assignments.deleteAssignment(id));
        const inserted: number[] = [];
        for (const activity of activities) {
          let placeId = activity.existing_place_id;
          if (placeId && !this.db.get('SELECT id FROM places WHERE id = ? AND trip_id = ?', placeId, data.trip_id)) throw new HttpException({ error: 'Place does not belong to trip' }, 422);
          if (!placeId) {
            const coordinates = activity.latitude != null && activity.longitude != null
              ? activity.coordinate_system === 'GCJ02' ? gcj02ToWgs84(activity.latitude, activity.longitude)
                : { lat: activity.latitude, lng: activity.longitude } : { lat: null, lng: null };
            const place = this.places.create(String(data.trip_id), {
              name: activity.name, description: activity.notes,
              // Do not copy GCJ-02 into TREK's WGS84 coordinates without conversion.
              lat: coordinates.lat,
              lng: coordinates.lng,
              address: activity.address, price: activity.cost, currency: activity.currency,
              duration_minutes: activity.duration_minutes, transport_mode: activity.transport_mode,
            });
            placeId = place.id;
          }
          const reuseId = reusable.get(activity.ref);
          placeRefs.set(activity.ref, placeId);
          const a = reuseId ? { id: reuseId } : this.assignments.createAssignment(day.id, placeId, activity.notes);
          if (reuseId) this.db.run('UPDATE day_assignments SET notes=? WHERE id=?', activity.notes || null, reuseId);
          this.db.run('UPDATE day_assignments SET assignment_time = ?, assignment_end_time = ?, incoming_leg_transport_mode = ? WHERE id = ?', activity.start_time || null, activity.end_time || null, activity.transport_mode, a.id);
          ids.push(Number(a.id));
          inserted.push(Number(a.id));
        }
        const order = [...preserved.slice(0, insertion), ...inserted, ...preserved.slice(insertion)];
        this.assignments.reorderAssignments(day.id, order);
        this.assignments.reanchorSegmentVias(day.id, old, order);
      }
      for (const operation of operations) {
        if (operation.name === 'create_day_note') {
          if (!this.notes) throw new Error('Native notes unavailable');
          const a = operation.arguments; this.notes.create(a.dayId, data.trip_id, a.text, a.time, a.icon, a.sort_order, a.color);
        } else if (operation.name === 'create_budget_item') {
          if (!this.budget) throw new Error('Native budget unavailable');
          this.budget.createBudgetItem(data.trip_id, operation.arguments);
        } else {
          if (!this.accommodations) throw new Error('Native accommodation unavailable');
          const { place_ref, ...args } = operation.arguments;
          const place_id = args.place_id ?? (place_ref ? placeRefs.get(place_ref) : undefined);
          if (!place_id) throw new HttpException('Accommodation draft place is missing', 422);
          const existing=this.db.get<DayAccommodation>('SELECT * FROM day_accommodations WHERE trip_id=? AND place_id=? AND start_day_id=? AND end_day_id=?',data.trip_id,place_id,args.start_day_id,args.end_day_id);
          const { accommodation } = existing?this.accommodations.updateAccommodation(existing.id,existing,{...args,place_id}):this.accommodations.createAccommodation(data.trip_id, { ...args, place_id });
          if(existing&&args.notes!==undefined)this.db.run("UPDATE reservations SET notes=? WHERE trip_id=? AND accommodation_id=? AND status='pending'",args.notes,data.trip_id,existing.id);
          // Upstream creates confirmed bookings by default. An Agent estimate
          // remains planned until the user records a real booking.
          if(!existing)this.db.run("UPDATE reservations SET status='pending' WHERE accommodation_id=? AND trip_id=?", (accommodation as { id: number }).id, data.trip_id);
        }
      }
      const at = new Date().toISOString();
      for(const leg of plannedTransport(plan)){
        const day=(snapshot.days as {id:number;day_number:number;date:string}[]).find(day=>day.day_number===leg.from.day_number)!;
        const key=candidateId+':'+leg.from.ref+':'+leg.to.ref;
        const existing=this.db.get<{id:number;status:string}>('SELECT id,status FROM reservations WHERE trip_id=? AND json_extract(metadata,\'$.agent_transport_key\')=?',data.trip_id,key);
        const record={title:`${leg.fromName} → ${leg.toName}${leg.code?' · '+leg.code:''}`,type:leg.type,day_id:day.id,
          reservation_time:leg.departure?`${leg.date??day.date}T${leg.departure}`:undefined,reservation_end_time:leg.arrival?`${leg.date??day.date}T${leg.arrival}`:undefined,
          status:'pending',needs_review:leg.type==='flight',notes:[leg.from.notes,leg.to.notes].join('\n'),
          metadata:{agent_transport_key:key,from:leg.fromName,to:leg.toName,...(leg.type==='train'?{train_number:leg.code}:leg.type==='flight'?{flight_number:leg.code,departure_airport:leg.fromName,arrival_airport:leg.toName}:{}),legs:[{from:leg.fromName,to:leg.toName,dep_day_id:day.id,arr_day_id:day.id,dep_time:leg.departure,arr_time:leg.arrival,...(leg.type==='train'?{train_number:leg.code}:{flight_number:leg.code})}]}};
        if(!existing)this.reservations!.create(data.trip_id,record);
        else if(existing.status==='pending')this.reservations!.update(existing.id,data.trip_id,record,this.reservations!.getReservation(existing.id,data.trip_id)!);
      }
      this.db.run('UPDATE agent_candidates SET adopted_at = ? WHERE candidate_id = ? AND version = ?', at, candidateId, version);
      this.bindAdoptedDraft(candidateId,version,data.trip_id,userId,plan,ids);
      return { candidate_id: candidateId, candidate_version: version, trip_id: data.trip_id, status: 'adopted', adopted_at: at, assignment_ids: ids };
    });
    // Notify only after the complete SQLite transaction commits. Operation
    // replay returns its original receipt without repeating notifications.
    if (!replay && 'assignment_ids' in result && Array.isArray(result.assignment_ids)) {
      const tripId = String(data.trip_id);
      for(const id of result.assignment_ids){
        const assignment=this.assignments.getAssignmentWithPlace(id);
        if(assignment)this.assignments.broadcast(tripId,'place:created',{place:this.places.get(tripId,String(assignment.place_id))!},undefined);
      }
      for (const placeId of new Set(data.plan.activities.filter(a => a.existing_place_id && a.cost != null).map(a => a.existing_place_id!))) {
        this.assignments.broadcast(tripId, 'place:updated', { place: this.places.get(tripId, String(placeId)) }, undefined);
      }
      for (const segment of data.plan.scope.segments) {
        for (const id of segment.replace_assignment_ids) {
          if (!this.db.get('SELECT 1 FROM day_assignments WHERE id=?', id)) this.assignments.broadcast(tripId, 'assignment:deleted', { assignmentId: id, dayId: segment.day_id }, undefined);
        }
        for (const id of result.assignment_ids) {
          const assignment = this.assignments.getAssignmentWithPlace(id);
          if (assignment?.day_id === segment.day_id) this.assignments.broadcast(tripId, segment.replace_assignment_ids.includes(id) ? 'assignment:updated' : 'assignment:created', { assignment }, undefined);
        }
        const orderedIds = this.db.all<{ id: number }>('SELECT id FROM day_assignments WHERE day_id=? ORDER BY order_index,id', segment.day_id).map(a => a.id);
        this.assignments.broadcast(tripId, 'assignment:reordered', { dayId: segment.day_id, orderedIds }, undefined);
      }
      this.assignments.reconcile(data.trip_id);
    }
    return result;
  }

  private bindAdoptedDraft(candidateId:string,version:number,tripId:number,userId:number,plan:AgentSave['plan'],ids:number[]){
    const rows=this.db.all<{session_id:string;payload:string}>('SELECT session_id,payload FROM agent_drafts WHERE trip_id=? AND user_id=?',tripId,userId);
    const ordered=plan.scope.segments.flatMap(segment=>plan.activities.filter(activity=>activity.scope_ref===segment.ref));
    const bindings=new Map(ordered.map((activity,index)=>[activity.ref,ids[index]]));
    for(const row of rows){
      const draft=JSON.parse(row.payload);
      if(draft.version+1!==version||candidateId!=='c:'+row.session_id)continue;
      const scope=structuredClone(plan.scope);
      for(const segment of scope.segments){
        const assigned=ordered.filter(a=>a.scope_ref===segment.ref).map(a=>bindings.get(a.ref)!);
        segment.replace_assignment_ids=assigned;
        const before=this.db.all<{id:number}>('SELECT id FROM day_assignments WHERE day_id=? ORDER BY order_index,id',segment.day_id);
        segment.insert_after_assignment_id=before[before.findIndex(a=>a.id===assigned[0])-1]?.id??null;
      }
      draft.activities=draft.activities.map((activity:AgentSave['plan']['activities'][number])=>{
        const assignment=this.assignments.getAssignmentWithPlace(bindings.get(activity.ref)!);
        const place=this.places.get(String(tripId),String(assignment!.place_id))!;
        return {...activity,existing_place_id:place.id,latitude:place.lat,longitude:place.lng,coordinate_system:place.lat==null?null:'WGS84'};
      });
      draft.base_revision=this.snapshot(tripId,userId).revision;
      draft.approved_scope=scope;draft.revision_scope=scope;draft.plan_details.scope=scope;
      draft.extras={};delete draft.plan_details.extensions?.native_operations;
      delete draft.plan;draft.validated=false;delete draft.checks;
      this.db.run('UPDATE agent_drafts SET payload=? WHERE session_id=?',JSON.stringify(draft),row.session_id);
    }
  }
}
