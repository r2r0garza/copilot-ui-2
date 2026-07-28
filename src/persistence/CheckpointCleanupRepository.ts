import type { DatabaseSync } from "node:sqlite";
import { isoNow } from "./database";

export class CheckpointCleanupRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(): Array<{
    threadId: string; checkpointNamespace: string; reason: string; attempts: number;
  }> {
    return (this.database.prepare(`
      SELECT thread_id, checkpoint_ns, reason, attempts
      FROM checkpoint_cleanup_queue ORDER BY created_at
    `).all() as Array<Record<string, unknown>>).map((row) => ({
      threadId: String(row.thread_id),
      checkpointNamespace: String(row.checkpoint_ns),
      reason: String(row.reason),
      attempts: Number(row.attempts),
    }));
  }

  markFailure(threadId: string, checkpointNamespace: string, error: string): void {
    this.database.prepare(`
      UPDATE checkpoint_cleanup_queue
      SET attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE thread_id = ? AND checkpoint_ns = ?
    `).run(error, isoNow(), threadId, checkpointNamespace);
  }

  remove(threadId: string, checkpointNamespace: string): void {
    this.database.prepare(`
      DELETE FROM checkpoint_cleanup_queue
      WHERE thread_id = ? AND checkpoint_ns = ?
    `).run(threadId, checkpointNamespace);
  }
}
