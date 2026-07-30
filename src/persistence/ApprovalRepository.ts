import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isoNow } from "./database";

export class ApprovalRepository {
  constructor(private readonly database: DatabaseSync) {}

  record(input: {
    id?: string; sessionId?: string | null; runId?: string | null;
    toolCallId?: string | null; toolName: string;
    decision: "once" | "session" | "deny" | "auto";
    processInstanceId: string;
  }): string {
    const id = input.id ?? randomUUID();
    this.database.prepare(`
      INSERT INTO approval_decisions (
        id, session_id, run_id, tool_call_id, tool_name,
        decision, process_instance_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.sessionId ?? null, input.runId ?? null,
      input.toolCallId ?? null, input.toolName, input.decision,
      input.processInstanceId, isoNow(),
    );
    return id;
  }

  countForSession(sessionId: string): number {
    return (
      this.database.prepare(`
        SELECT COUNT(*) AS count FROM approval_decisions WHERE session_id = ?
      `).get(sessionId) as { count: number }
    ).count;
  }
}
