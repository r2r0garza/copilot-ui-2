import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inTransaction, isoNow } from "./database";
import type { ChatSession, SessionStatus, TitleSource } from "./types";

interface SessionRow {
  id: string;
  thread_id: string;
  checkpoint_ns: string;
  title: string;
  title_source: TitleSource;
  selected_model_key: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_event_at: string;
}

function fromRow(row: SessionRow): ChatSession {
  return {
    id: row.id,
    threadId: row.thread_id,
    checkpointNamespace: row.checkpoint_ns,
    title: row.title,
    titleSource: row.title_source,
    selectedModelKey: row.selected_model_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEventAt: row.last_event_at,
  };
}

export class SessionRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: {
    id?: string;
    threadId?: string;
    title?: string;
    selectedModelKey?: string | null;
  } = {}): ChatSession {
    const now = isoNow();
    const session: ChatSession = {
      id: input.id ?? randomUUID(),
      threadId: input.threadId ?? randomUUID(),
      checkpointNamespace: "",
      title: input.title ?? "New chat",
      titleSource: "default",
      selectedModelKey: input.selectedModelKey ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastEventAt: now,
    };
    this.database.prepare(`
      INSERT INTO chat_sessions (
        id, thread_id, checkpoint_ns, title, title_source,
        selected_model_key, status, created_at, updated_at, last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.threadId, session.checkpointNamespace, session.title,
      session.titleSource, session.selectedModelKey, session.status,
      session.createdAt, session.updatedAt, session.lastEventAt,
    );
    return session;
  }

  get(id: string): ChatSession | undefined {
    const row = this.database
      .prepare("SELECT * FROM chat_sessions WHERE id = ?")
      .get(id) as unknown as SessionRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(status: SessionStatus = "active"): ChatSession[] {
    return (this.database
      .prepare(`
        SELECT * FROM chat_sessions
        WHERE status = ?
        ORDER BY last_event_at DESC, created_at DESC
      `)
      .all(status) as unknown as SessionRow[]).map(fromRow);
  }

  rename(id: string, title: string): void {
    this.updateTitle(id, title, "manual");
  }

  setGeneratedTitle(id: string, title: string): boolean {
    const now = isoNow();
    const result = this.database.prepare(`
      UPDATE chat_sessions
      SET title = ?, title_source = 'generated', updated_at = ?
      WHERE id = ? AND title_source = 'default'
    `).run(title, now, id);
    return result.changes === 1;
  }

  setModel(id: string, modelKey: string): void {
    this.database.prepare(`
      UPDATE chat_sessions
      SET selected_model_key = ?, updated_at = ?
      WHERE id = ?
    `).run(modelKey, isoNow(), id);
  }

  markDeletingAndQueue(id: string): void {
    inTransaction(this.database, () => {
      const session = this.get(id);
      if (!session) return;
      const now = isoNow();
      this.database.prepare(`
        UPDATE chat_sessions SET status = 'deleting', updated_at = ? WHERE id = ?
      `).run(now, id);
      this.database.prepare(`
        INSERT INTO checkpoint_cleanup_queue (
          thread_id, checkpoint_ns, reason, created_at, updated_at
        ) VALUES (?, ?, 'session_deleted', ?, ?)
        ON CONFLICT(thread_id, checkpoint_ns) DO UPDATE SET
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `).run(session.threadId, session.checkpointNamespace, now, now);
    });
  }

  clear(id: string, newThreadId: string = randomUUID()): string {
    return inTransaction(this.database, () => {
      const session = this.get(id);
      if (!session) throw new Error(`Session not found: ${id}`);
      const now = isoNow();
      this.database.prepare(`
        UPDATE chat_sessions
        SET thread_id = ?, updated_at = ?, last_event_at = ?
        WHERE id = ?
      `).run(newThreadId, now, now, id);
      this.database
        .prepare("DELETE FROM conversation_events WHERE session_id = ?")
        .run(id);
      this.database.prepare(`
        INSERT INTO checkpoint_cleanup_queue (
          thread_id, checkpoint_ns, reason, created_at, updated_at
        ) VALUES (?, ?, 'session_cleared', ?, ?)
        ON CONFLICT(thread_id, checkpoint_ns) DO UPDATE SET
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `).run(session.threadId, session.checkpointNamespace, now, now);
      return session.threadId;
    });
  }

  hardDelete(id: string): void {
    this.database.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
  }

  private updateTitle(
    id: string,
    title: string,
    source: TitleSource,
  ): void {
    this.database.prepare(`
      UPDATE chat_sessions
      SET title = ?, title_source = ?, updated_at = ?
      WHERE id = ?
    `).run(title, source, isoNow(), id);
  }
}
