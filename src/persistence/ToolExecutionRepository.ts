import type { DatabaseSync } from "node:sqlite";

export type ToolEffectClass = "read_only" | "idempotent_write" | "non_idempotent";
export type ToolExecutionStatus =
  | "requested" | "waiting_approval" | "approved" | "running"
  | "succeeded" | "failed" | "denied" | "uncertain";

export class ToolExecutionRepository {
  constructor(private readonly database: DatabaseSync) {}

  request(input: {
    runId: string; toolCallId: string; toolName: string; arguments: unknown;
    inputHash: string; effectClass: ToolEffectClass;
  }): void {
    this.database.prepare(`
      INSERT INTO tool_executions (
        run_id, tool_call_id, tool_name, input_json, input_hash,
        effect_class, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'requested')
    `).run(
      input.runId, input.toolCallId, input.toolName,
      JSON.stringify(input.arguments), input.inputHash, input.effectClass,
    );
  }

  transition(
    runId: string,
    toolCallId: string,
    status: ToolExecutionStatus,
    output?: unknown,
  ): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE tool_executions SET
        status = ?,
        output_json = COALESCE(?, output_json),
        started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
        finished_at = CASE
          WHEN ? IN ('succeeded', 'failed', 'denied') THEN ?
          ELSE finished_at
        END
      WHERE run_id = ? AND tool_call_id = ?
    `).run(
      status, output === undefined ? null : JSON.stringify(output),
      status, now, status, now, runId, toolCallId,
    );
  }
}
