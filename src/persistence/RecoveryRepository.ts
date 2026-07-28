import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inTransaction, isoNow } from "./database";

export type ReconciliationDecision =
  | "mark_completed"
  | "retry"
  | "abandon";

export class RecoveryRepository {
  constructor(private readonly database: DatabaseSync) {}

  reconcile(input: {
    runId: string;
    toolCallId: string;
    decision: ReconciliationDecision;
    warningAcknowledged: boolean;
    processInstanceId: string;
  }): string {
    return inTransaction(this.database, () => {
      const run = this.database.prepare(`
        SELECT status, recovery_class
        FROM agent_runs WHERE id = ?
      `).get(input.runId) as {
        status: string;
        recovery_class: string | null;
      } | undefined;
      if (
        !run ||
        run.status !== "interrupted" ||
        run.recovery_class !== "needs_review"
      ) {
        throw new Error(
          `Run "${input.runId}" is not awaiting side-effect reconciliation.`,
        );
      }
      const tool = this.database.prepare(`
        SELECT status, effect_class
        FROM tool_executions
        WHERE run_id = ? AND tool_call_id = ?
      `).get(input.runId, input.toolCallId) as {
        status: string;
        effect_class: string;
      } | undefined;
      if (
        !tool ||
        tool.status !== "uncertain" ||
        tool.effect_class === "read_only"
      ) {
        throw new Error(
          `Tool call "${input.toolCallId}" is not an uncertain side effect.`,
        );
      }
      if (input.decision === "retry" && !input.warningAcknowledged) {
        throw new Error(
          "Retry requires acknowledging that the original operation may already have completed.",
        );
      }

      const id = randomUUID();
      const now = isoNow();
      this.database.prepare(`
        INSERT INTO recovery_reconciliations (
          id, run_id, tool_call_id, decision, warning_acknowledged,
          process_instance_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.runId,
        input.toolCallId,
        input.decision,
        input.warningAcknowledged ? 1 : 0,
        input.processInstanceId,
        now,
      );

      if (input.decision === "abandon") {
        this.database.prepare(`
          UPDATE agent_runs SET
            status = 'cancelled',
            last_error = 'Recovery abandoned by user.',
            completed_at = ?,
            updated_at = ?
          WHERE id = ?
        `).run(now, now, input.runId);
      } else {
        this.database.prepare(`
          UPDATE tool_executions SET
            status = ?,
            output_json = CASE
              WHEN ? = 'mark_completed'
              THEN json_object('reconciled', 'mark_completed')
              ELSE output_json
            END,
            finished_at = CASE
              WHEN ? = 'mark_completed' THEN ?
              ELSE NULL
            END
          WHERE run_id = ? AND tool_call_id = ?
        `).run(
          input.decision === "mark_completed" ? "succeeded" : "approved",
          input.decision,
          input.decision,
          now,
          input.runId,
          input.toolCallId,
        );
        const remaining = this.database.prepare(`
          SELECT tool_name
          FROM tool_executions
          WHERE run_id = ?
            AND status = 'uncertain'
            AND effect_class <> 'read_only'
          ORDER BY tool_call_id
          LIMIT 1
        `).get(input.runId) as { tool_name: string } | undefined;
        this.database.prepare(`
          UPDATE agent_runs SET
            recovery_class = ?,
            last_error = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          remaining ? "needs_review" : "safe_to_resume",
          remaining
            ? `${remaining.tool_name} also has an uncertain outcome and must be reviewed before resuming.`
            : input.decision === "mark_completed"
              ? "Side effect marked completed by user; ready for explicit resume."
              : "Retry authorized with duplicate-effect warning acknowledged; ready for explicit resume.",
          now,
          input.runId,
        );
      }
      return id;
    });
  }

  countForRun(runId: string): number {
    return (
      this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM recovery_reconciliations
        WHERE run_id = ?
      `).get(runId) as { count: number }
    ).count;
  }
}
