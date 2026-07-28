import type { DatabaseSync } from "node:sqlite";
import { inTransaction, isoNow } from "./database";

export type ToolEffectClass = "read_only" | "idempotent_write" | "non_idempotent";
export type ToolExecutionStatus =
  | "requested" | "waiting_approval" | "approved" | "running"
  | "succeeded" | "failed" | "denied" | "uncertain";

export interface ToolExecutionRecord {
  runId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  inputHash: string;
  effectClass: ToolEffectClass;
  status: ToolExecutionStatus;
  output?: unknown;
}

export type ToolExecutionPreparation =
  | { kind: "execute"; record: ToolExecutionRecord }
  | { kind: "replay"; record: ToolExecutionRecord };

export class ToolExecutionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionIntegrityError";
  }
}

export class ToolExecutionBlockedError extends Error {
  constructor(
    message: string,
    readonly status: ToolExecutionStatus,
  ) {
    super(message);
    this.name = "ToolExecutionBlockedError";
  }
}

export class ToolExecutionRepository {
  constructor(private readonly database: DatabaseSync) {}

  request(input: {
    runId: string; toolCallId: string; toolName: string; arguments: unknown;
    inputHash: string; effectClass: ToolEffectClass;
  }): ToolExecutionRecord {
    return inTransaction(this.database, () => {
      const existing = this.get(input.runId, input.toolCallId);
      if (existing) {
        this.assertSameRequest(existing, input.toolName, input.inputHash);
        return existing;
      }
      this.database.prepare(`
        INSERT INTO tool_executions (
          run_id, tool_call_id, tool_name, input_json, input_hash,
          effect_class, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'requested')
      `).run(
        input.runId, input.toolCallId, input.toolName,
        JSON.stringify(input.arguments), input.inputHash, input.effectClass,
      );
      return this.getRequired(input.runId, input.toolCallId);
    });
  }

  prepareExecution(
    runId: string,
    toolCallId: string,
    toolName: string,
    inputHash: string,
  ): ToolExecutionPreparation {
    return inTransaction(this.database, () => {
      const record = this.getRequired(runId, toolCallId);
      this.assertSameRequest(record, toolName, inputHash);
      if (
        record.status === "succeeded" ||
        record.status === "failed" ||
        record.status === "denied"
      ) {
        if (record.output === undefined) {
          throw new ToolExecutionIntegrityError(
            `Terminal tool call "${toolCallId}" has no durable result to replay.`,
          );
        }
        return { kind: "replay", record };
      }
      if (record.status === "running" || record.status === "uncertain") {
        throw new ToolExecutionBlockedError(
          `Tool call "${toolCallId}" has an uncertain outcome and cannot be executed automatically.`,
          record.status,
        );
      }
      if (record.status === "waiting_approval") {
        throw new ToolExecutionBlockedError(
          `Tool call "${toolCallId}" is still waiting for approval.`,
          record.status,
        );
      }
      const now = isoNow();
      this.database.prepare(`
        UPDATE tool_executions SET
          status = 'running',
          started_at = ?,
          finished_at = NULL
        WHERE run_id = ? AND tool_call_id = ?
      `).run(now, runId, toolCallId);
      return {
        kind: "execute",
        record: { ...record, status: "running" },
      };
    });
  }

  transition(
    runId: string,
    toolCallId: string,
    status: ToolExecutionStatus,
    output?: unknown,
  ): void {
    const now = isoNow();
    const result = this.database.prepare(`
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
    if (result.changes !== 1) {
      throw new ToolExecutionIntegrityError(
        `Tool call "${toolCallId}" does not exist in run "${runId}".`,
      );
    }
  }

  setEffectClass(
    runId: string,
    toolCallId: string,
    effectClass: ToolEffectClass,
  ): void {
    const result = this.database.prepare(`
      UPDATE tool_executions SET effect_class = ?
      WHERE run_id = ? AND tool_call_id = ?
    `).run(effectClass, runId, toolCallId);
    if (result.changes !== 1) {
      throw new ToolExecutionIntegrityError(
        `Tool call "${toolCallId}" does not exist in run "${runId}".`,
      );
    }
  }

  get(runId: string, toolCallId: string): ToolExecutionRecord | undefined {
    const row = this.database.prepare(`
      SELECT
        run_id, tool_call_id, tool_name, input_json, input_hash,
        effect_class, status, output_json
      FROM tool_executions
      WHERE run_id = ? AND tool_call_id = ?
    `).get(runId, toolCallId) as ToolExecutionRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  markRunningUncertain(runId: string): ToolExecutionRecord[] {
    this.database.prepare(`
      UPDATE tool_executions
      SET status = 'uncertain'
      WHERE run_id = ? AND status = 'running'
    `).run(runId);
    return this.listUncertain(runId);
  }

  listUncertain(runId: string): ToolExecutionRecord[] {
    return (
      this.database.prepare(`
        SELECT
          run_id, tool_call_id, tool_name, input_json, input_hash,
          effect_class, status, output_json
        FROM tool_executions
        WHERE run_id = ? AND status = 'uncertain'
        ORDER BY tool_call_id
      `).all(runId) as unknown as ToolExecutionRow[]
    ).map(mapRow);
  }

  list(runId: string): ToolExecutionRecord[] {
    return (
      this.database.prepare(`
        SELECT
          run_id, tool_call_id, tool_name, input_json, input_hash,
          effect_class, status, output_json
        FROM tool_executions
        WHERE run_id = ?
        ORDER BY rowid
      `).all(runId) as unknown as ToolExecutionRow[]
    ).map(mapRow);
  }

  authorizeReadOnlyRetries(runId: string): number {
    return Number(this.database.prepare(`
      UPDATE tool_executions
      SET status = 'approved'
      WHERE run_id = ?
        AND status = 'uncertain'
        AND effect_class = 'read_only'
    `).run(runId).changes);
  }

  private getRequired(runId: string, toolCallId: string): ToolExecutionRecord {
    const record = this.get(runId, toolCallId);
    if (!record) {
      throw new ToolExecutionIntegrityError(
        `Tool call "${toolCallId}" does not exist in run "${runId}".`,
      );
    }
    return record;
  }

  private assertSameRequest(
    record: ToolExecutionRecord,
    toolName: string,
    inputHash: string,
  ): void {
    if (record.toolName !== toolName || record.inputHash !== inputHash) {
      throw new ToolExecutionIntegrityError(
        `Tool call "${record.toolCallId}" was reused with different input.`,
      );
    }
  }
}

interface ToolExecutionRow {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  input_json: string;
  input_hash: string;
  effect_class: ToolEffectClass;
  status: ToolExecutionStatus;
  output_json: string | null;
}

function mapRow(row: ToolExecutionRow): ToolExecutionRecord {
  return {
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    arguments: JSON.parse(row.input_json),
    inputHash: row.input_hash,
    effectClass: row.effect_class,
    status: row.status,
    ...(row.output_json === null ? {} : { output: JSON.parse(row.output_json) }),
  };
}
