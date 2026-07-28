import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inTransaction, isoNow } from "./database";

export type RunStatus =
  | "queued" | "running" | "waiting_approval" | "paused" | "interrupted"
  | "completed" | "failed" | "cancelled";

export type RecoveryClass =
  | "safe_to_resume"
  | "waiting_for_approval"
  | "needs_review"
  | "not_resumable";

export interface AgentRunRecord {
  id: string;
  sessionId: string | null;
  goalId: string | null;
  threadId: string;
  checkpointNamespace: string;
  lastCheckpointId: string | null;
  compatibilityVersion: number;
  status: RunStatus;
  recoveryClass: RecoveryClass | null;
  lastError: string | null;
}

export class RunRepository {
  constructor(private readonly database: DatabaseSync) {}

  start(input: {
    id?: string; sessionId?: string | null; goalId?: string | null;
    threadId: string; checkpointNamespace?: string; modelKey?: string | null;
    processInstanceId: string; leaseExpiresAt: string;
    compatibilityVersion?: number;
  }): { runId: string; attemptId: string } {
    return inTransaction(this.database, () => {
      const runId = input.id ?? randomUUID();
      const attemptId = randomUUID();
      const now = isoNow();
      this.database.prepare(`
        INSERT INTO agent_runs (
          id, session_id, goal_id, thread_id, checkpoint_ns, model_key,
          compatibility_version, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(
        runId, input.sessionId ?? null, input.goalId ?? null, input.threadId,
        input.checkpointNamespace ?? "", input.modelKey ?? null,
        input.compatibilityVersion ?? 1, now, now,
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

  get(runId: string): AgentRunRecord | undefined {
    const row = this.database.prepare(`
      SELECT
        id, session_id, goal_id, thread_id, checkpoint_ns,
        last_checkpoint_id, compatibility_version, status,
        recovery_class, last_error
      FROM agent_runs
      WHERE id = ?
    `).get(runId) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  listInterruptedForSession(sessionId: string): AgentRunRecord[] {
    return (
      this.database.prepare(`
        SELECT
          id, session_id, goal_id, thread_id, checkpoint_ns,
          last_checkpoint_id, compatibility_version, status,
          recovery_class, last_error
        FROM agent_runs
        WHERE session_id = ?
          AND status = 'interrupted'
          AND recovery_class IS NOT NULL
        ORDER BY updated_at DESC
      `).all(sessionId) as unknown as RunRow[]
    ).map(mapRun);
  }

  interruptExpiredAttempts(
    expiredBefore: string,
    reason = "Attempt lease expired before process restart.",
    currentProcessInstanceId?: string,
  ): AgentRunRecord[] {
    return inTransaction(this.database, () => {
      const rows = this.database.prepare(`
        SELECT DISTINCT
          runs.id, runs.session_id, runs.goal_id, runs.thread_id,
          runs.checkpoint_ns, runs.last_checkpoint_id,
          runs.compatibility_version, runs.status,
          runs.recovery_class, runs.last_error
        FROM agent_runs AS runs
        JOIN run_attempts AS attempts ON attempts.run_id = runs.id
        WHERE attempts.status IN ('starting', 'running')
          AND (
            attempts.lease_expires_at IS NULL
            OR attempts.lease_expires_at <= ?
            OR (
              ? IS NOT NULL
              AND attempts.process_instance_id <> ?
            )
          )
      `).all(
        expiredBefore,
        currentProcessInstanceId ?? null,
        currentProcessInstanceId ?? null,
      ) as unknown as RunRow[];
      if (rows.length === 0) {
        return [];
      }
      const now = isoNow();
      const attemptStatement = this.database.prepare(`
        UPDATE run_attempts SET
          status = 'interrupted',
          ended_at = ?,
          interruption_reason = ?
        WHERE run_id = ?
          AND status IN ('starting', 'running')
      `);
      const runStatement = this.database.prepare(`
        UPDATE agent_runs SET
          status = 'interrupted',
          recovery_class = NULL,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
      `);
      for (const row of rows) {
        attemptStatement.run(now, reason, row.id);
        runStatement.run(reason, now, row.id);
      }
      return rows.map((row) => ({
        ...mapRun(row),
        status: "interrupted",
        recoveryClass: null,
        lastError: reason,
      }));
    });
  }

  heartbeat(attemptId: string, leaseExpiresAt: string): void {
    const result = this.database.prepare(`
      UPDATE run_attempts SET
        heartbeat_at = ?,
        lease_expires_at = ?
      WHERE id = ? AND status IN ('starting', 'running')
    `).run(isoNow(), leaseExpiresAt, attemptId);
    if (result.changes !== 1) {
      throw new Error(`Cannot renew inactive run attempt "${attemptId}".`);
    }
  }

  setExecutionStatus(
    runId: string,
    status: Extract<RunStatus, "running" | "waiting_approval">,
  ): void {
    this.database.prepare(`
      UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, isoNow(), runId);
  }

  recordCheckpoint(runId: string, checkpointId: string): void {
    this.database.prepare(`
      UPDATE agent_runs SET last_checkpoint_id = ?, updated_at = ? WHERE id = ?
    `).run(checkpointId, isoNow(), runId);
  }

  setRecovery(
    runId: string,
    recoveryClass: RecoveryClass,
    reason: string,
    checkpointId?: string,
  ): void {
    this.database.prepare(`
      UPDATE agent_runs SET
        status = 'interrupted',
        recovery_class = ?,
        last_error = ?,
        last_checkpoint_id = COALESCE(?, last_checkpoint_id),
        updated_at = ?
      WHERE id = ?
    `).run(recoveryClass, reason, checkpointId ?? null, isoNow(), runId);
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

interface RunRow {
  id: string;
  session_id: string | null;
  goal_id: string | null;
  thread_id: string;
  checkpoint_ns: string;
  last_checkpoint_id: string | null;
  compatibility_version: number;
  status: RunStatus;
  recovery_class: RecoveryClass | null;
  last_error: string | null;
}

function mapRun(row: RunRow): AgentRunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    goalId: row.goal_id,
    threadId: row.thread_id,
    checkpointNamespace: row.checkpoint_ns,
    lastCheckpointId: row.last_checkpoint_id,
    compatibilityVersion: row.compatibility_version,
    status: row.status,
    recoveryClass: row.recovery_class,
    lastError: row.last_error,
  };
}
