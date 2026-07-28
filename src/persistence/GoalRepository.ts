import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isoNow } from "./database";

export type GoalStatus =
  | "draft" | "queued" | "running" | "paused"
  | "completed" | "failed" | "cancelled";

export class GoalRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: {
    id?: string; sessionId?: string | null; title: string; objective: string;
    priority?: number;
  }): string {
    const id = input.id ?? randomUUID();
    const now = isoNow();
    this.database.prepare(`
      INSERT INTO goals (
        id, session_id, title, objective, status, priority,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, 1, ?, ?)
    `).run(
      id, input.sessionId ?? null, input.title, input.objective,
      input.priority ?? 0, now, now,
    );
    return id;
  }

  updateStatus(id: string, status: GoalStatus, expectedVersion: number): boolean {
    const result = this.database.prepare(`
      UPDATE goals SET
        status = ?, version = version + 1, updated_at = ?,
        completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
      WHERE id = ? AND version = ?
    `).run(status, isoNow(), status, isoNow(), id, expectedVersion);
    return result.changes === 1;
  }
}
