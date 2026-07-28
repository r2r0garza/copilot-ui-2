import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import { PersistenceService } from "../src/persistence/PersistenceService";
import {
  CURRENT_GRAPH_COMPATIBILITY_VERSION,
  RecoveryBlockedError,
} from "../src/persistence/RecoveryService";
import type { ToolEffectClass } from "../src/persistence/ToolExecutionRepository";

function uri(fsPath: string) {
  return { fsPath, toString: () => `file://${fsPath}` };
}

const State = Annotation.Root({
  values: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

async function writeCheckpoint(
  service: PersistenceService,
  threadId: string,
  pendingApproval = false,
): Promise<void> {
  const graph = new StateGraph(State)
    .addNode("work", async () => ({ values: ["checkpointed"] }))
    .addNode("review", async () => {
      if (pendingApproval) {
        interrupt({ kind: "approval", question: "Continue?" });
      }
      return { values: ["reviewed"] };
    })
    .addEdge(START, "work")
    .addEdge("work", "review")
    .addEdge("review", END)
    .compile({ checkpointer: service.checkpointer });
  await graph.invoke(
    { values: ["input"] },
    { configurable: { thread_id: threadId, checkpoint_ns: "" } },
  );
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-recovery-"));
  const service = await PersistenceService.open(
    uri(join(root, "storage")),
    uri(join(root, "workspace")),
  );

  try {
    const fixtures = new Map<string, { runId: string; sessionId: string }>();

    const createRun = async (
      name: string,
      options: {
        checkpoint?: "complete" | "approval" | "missing";
        compatibilityVersion?: number;
        toolEffect?: ToolEffectClass;
      } = {},
    ) => {
      const session = service.sessions.create({
        id: `${name}-session`,
        threadId: `${name}-thread`,
      });
      const { runId } = service.runs.start({
        id: `${name}-run`,
        sessionId: session.id,
        threadId: session.threadId,
        processInstanceId: "dead-process",
        leaseExpiresAt: "2026-07-28T11:00:00.000Z",
        compatibilityVersion:
          options.compatibilityVersion ??
          CURRENT_GRAPH_COMPATIBILITY_VERSION,
      });
      if (options.checkpoint !== "missing") {
        await writeCheckpoint(
          service,
          session.threadId,
          options.checkpoint === "approval",
        );
      }
      if (options.toolEffect) {
        service.toolExecutions.request({
          runId,
          toolCallId: `${name}-tool`,
          toolName:
            options.toolEffect === "read_only"
              ? "read_file"
              : "execute_command",
          arguments: { fixture: name },
          inputHash: `${name}-hash`,
          effectClass: options.toolEffect,
        });
        service.toolExecutions.transition(runId, `${name}-tool`, "running");
      }
      fixtures.set(name, { runId, sessionId: session.id });
    };

    await createRun("safe");
    await createRun("safe-read", { toolEffect: "read_only" });
    await createRun("approval", { checkpoint: "approval" });
    await createRun("mark", { toolEffect: "non_idempotent" });
    await createRun("retry", { toolEffect: "non_idempotent" });
    await createRun("abandon", { toolEffect: "non_idempotent" });
    await createRun("missing", { checkpoint: "missing" });
    await createRun("incompatible", { compatibilityVersion: 99 });

    const recovered = await service.recovery.recoverExpiredAttempts(
      new Date("2026-07-28T12:00:00.000Z"),
    );
    assert.equal(recovered.length, 8);
    const recoveryClass = (name: string) =>
      recovered.find(({ run }) => run.id === fixtures.get(name)?.runId)
        ?.recoveryClass;
    assert.equal(recoveryClass("safe"), "safe_to_resume");
    assert.equal(recoveryClass("safe-read"), "safe_to_resume");
    assert.equal(recoveryClass("approval"), "waiting_for_approval");
    assert.equal(recoveryClass("mark"), "needs_review");
    assert.equal(recoveryClass("retry"), "needs_review");
    assert.equal(recoveryClass("abandon"), "needs_review");
    assert.equal(recoveryClass("missing"), "not_resumable");
    assert.equal(recoveryClass("incompatible"), "not_resumable");

    const interruptedAttempts = service.database.prepare(`
      SELECT COUNT(*) AS count
      FROM run_attempts
      WHERE status = 'interrupted'
    `).get() as { count: number };
    assert.equal(interruptedAttempts.count, 8);
    assert.equal(
      service.toolExecutions.listUncertain(fixtures.get("safe-read")!.runId)[0]
        ?.effectClass,
      "read_only",
    );

    const mark = fixtures.get("mark")!;
    assert.throws(
      () => service.recovery.assertExplicitResumeAllowed(mark.runId),
      (error: unknown) =>
        error instanceof RecoveryBlockedError &&
        error.recoveryClass === "needs_review",
    );
    service.recoveryDecisions.reconcile({
      runId: mark.runId,
      toolCallId: "mark-tool",
      decision: "mark_completed",
      warningAcknowledged: false,
      processInstanceId: "recovery-process",
    });
    assert.equal(service.recoveryDecisions.countForRun(mark.runId), 1);
    assert.equal(
      service.recovery.assertExplicitResumeAllowed(mark.runId).recoveryClass,
      "safe_to_resume",
    );
    assert.deepEqual(
      {
        ...(service.database.prepare(`
        SELECT status, output_json FROM tool_executions
        WHERE run_id = ? AND tool_call_id = 'mark-tool'
        `).get(mark.runId) as object),
      },
      {
        status: "succeeded",
        output_json: '{"reconciled":"mark_completed"}',
      },
    );

    const retry = fixtures.get("retry")!;
    assert.throws(() =>
      service.recoveryDecisions.reconcile({
        runId: retry.runId,
        toolCallId: "retry-tool",
        decision: "retry",
        warningAcknowledged: false,
        processInstanceId: "recovery-process",
      }),
    );
    assert.equal(service.recoveryDecisions.countForRun(retry.runId), 0);
    service.recoveryDecisions.reconcile({
      runId: retry.runId,
      toolCallId: "retry-tool",
      decision: "retry",
      warningAcknowledged: true,
      processInstanceId: "recovery-process",
    });
    assert.equal(
      (
        service.database.prepare(`
          SELECT status FROM tool_executions
          WHERE run_id = ? AND tool_call_id = 'retry-tool'
        `).get(retry.runId) as { status: string }
      ).status,
      "approved",
    );

    const abandon = fixtures.get("abandon")!;
    service.recoveryDecisions.reconcile({
      runId: abandon.runId,
      toolCallId: "abandon-tool",
      decision: "abandon",
      warningAcknowledged: false,
      processInstanceId: "recovery-process",
    });
    assert.equal(service.recoveryDecisions.countForRun(abandon.runId), 1);
    assert.equal(service.runs.get(abandon.runId)?.status, "cancelled");
    assert.equal(
      service.toolExecutions.listUncertain(abandon.runId)[0]?.status,
      "uncertain",
      "abandonment preserves the uncertain tool audit trail",
    );

    const missing = service.runs.get(fixtures.get("missing")!.runId);
    const incompatible = service.runs.get(
      fixtures.get("incompatible")!.runId,
    );
    assert.match(missing?.lastError ?? "", /no persisted checkpoint/i);
    assert.match(incompatible?.lastError ?? "", /not supported/i);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Recovery integration test passed: stale leases, checkpoint classes, continuation blocking, and reconciliation decisions are durable",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
