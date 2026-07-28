import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inTransaction, isoNow } from "./database";

export type RunStatus =
  | "queued" | "running" | "waiting_approval" | "paused" | "interrupted"
  | "completed" | "failed" | "cancelled";

export class RunRepository {
  constructor(private readonly database: DatabaseSync) {}

  start(input: {
    id?: string; sessionId?: string | null; goalId?: string | null;
    threadId: string; checkpointNamespace?: string; modelKey?: string | null;
    processInstanceId: string; leaseExpiresAt: string;
  }): { runId: string; attemptId: string } {
    return inTransaction(this.database, () => {
      const runId = input.id ?? randomUUID();
      const attemptId = randomUUID();
      const now = isoNow();
      this.database.prepare(`
        INSERT INTO agent_runs (
          id, session_id, goal_id, thread_id, checkpoint_ns, model_key,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(
        runId, input.sessionId ?? null, input.goalId ?? null, input.threadId,
        input.checkpointNamespace ?? "", input.modelKey ?? null, now, now,
      );
      this.database.prepare(`
        INSERT INTO run_attempts (
          id, run_id, process_instance_id, status, lease_expires_at,
          heartbeat_at, started_at
        ) VALUES (?, ?, ?, 'running', ?, ?, ?)
      `).run(
        attemptId, runId, input.processInstanceId, input.leaseExpiresAt, now, now,
      );
      return { runId, attemptId };
    });
  }

  finish(
    runId: string,
    attemptId: string,
    status: Extract<RunStatus, "completed" | "failed" | "cancelled">,
    lastError?: string,
  ): void {
    inTransaction(this.database, () => {
      const now = isoNow();
      this.database.prepare(`
        UPDATE agent_runs SET
          status = ?, last_error = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(status, lastError ?? null, now, now, runId);
      this.database.prepare(`
        UPDATE run_attempts SET
          status = ?, ended_at = ?
        WHERE id = ?
      `).run(status === "completed" ? "completed" : "failed", now, attemptId);
    });
  }

  saveTodoSnapshot(
    runId: string,
    checkpointId: string,
    todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>,
  ): void {
    inTransaction(this.database, () => {
      const statement = this.database.prepare(`
        INSERT OR REPLACE INTO todo_snapshots (
          run_id, checkpoint_id, ordinal, content, status, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const now = isoNow();
      todos.forEach((todo, ordinal) => {
        statement.run(
          runId, checkpointId, ordinal, todo.content, todo.status, now,
        );
      });
    });
  }
}
