import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inTransaction, isoNow } from "./database";
import {
  validateEventPayload,
  type ConversationEvent,
  type ConversationEventType,
  type EventPayload,
} from "./types";

interface EventRow {
  id: string;
  session_id: string;
  run_id: string | null;
  sequence: number;
  event_type: ConversationEventType;
  payload_json: string;
  created_at: string;
}

export class ConversationEventRepository {
  constructor(private readonly database: DatabaseSync) {}

  append(input: {
    id?: string;
    sessionId: string;
    runId?: string | null;
    eventType: ConversationEventType;
    payload: EventPayload;
    createdAt?: string;
  }): ConversationEvent {
    const payload = validateEventPayload(input.eventType, input.payload);
    return inTransaction(this.database, () => {
      const sequence = (
        this.database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
          FROM conversation_events WHERE session_id = ?
        `).get(input.sessionId) as { sequence: number }
      ).sequence;
      const event: ConversationEvent = {
        id: input.id ?? randomUUID(),
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        sequence,
        eventType: input.eventType,
        payload,
        createdAt: input.createdAt ?? isoNow(),
      };
      this.database.prepare(`
        INSERT INTO conversation_events (
          id, session_id, run_id, sequence, event_type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id, event.sessionId, event.runId, event.sequence, event.eventType,
        JSON.stringify(event.payload), event.createdAt,
      );
      this.database.prepare(`
        UPDATE chat_sessions
        SET last_event_at = ?, updated_at = ?
        WHERE id = ?
      `).run(event.createdAt, event.createdAt, event.sessionId);
      return event;
    });
  }

  list(sessionId: string): ConversationEvent[] {
    const rows = this.database.prepare(`
      SELECT * FROM conversation_events
      WHERE session_id = ?
      ORDER BY sequence
    `).all(sessionId) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      sequence: row.sequence,
      eventType: row.event_type,
      payload: validateEventPayload(
        row.event_type,
        JSON.parse(row.payload_json) as unknown,
      ),
      createdAt: row.created_at,
    }));
  }
}
