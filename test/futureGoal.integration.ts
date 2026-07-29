import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Annotation,
  END,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { PersistenceService } from "../src/persistence/PersistenceService";

function uri(fsPath: string) {
  return { fsPath, toString: () => `file://${fsPath}` };
}

type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

const GoalState = Annotation.Root({
  todos: Annotation<Todo[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
});

function createGoalGraph(service: PersistenceService) {
  return new StateGraph(GoalState)
    .addNode("checkpoint", async () => ({}))
    .addEdge(START, "checkpoint")
    .addEdge("checkpoint", END)
    .compile({ checkpointer: service.checkpointer });
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-future-goal-"));
  const service = await PersistenceService.open(
    uri(join(root, "storage")),
    uri(join(root, "workspace")),
  );

  try {
    const session = service.sessions.create({
      id: "goal-origin-session",
      threadId: "chat-thread",
    });
    const goalId = service.goals.create({
      id: "durable-goal",
      sessionId: session.id,
      title: "Resume a durable goal",
      objective: "Prove future goal state survives an interrupted attempt.",
    });
    assert.equal(service.goals.updateStatus(goalId, "queued", 1), true);

    const goalThreadId = "durable-goal-thread";
    const firstAttempt = service.runs.start({
      id: "durable-goal-run",
      sessionId: session.id,
      goalId,
      threadId: goalThreadId,
      processInstanceId: "process-before-interruption",
      leaseExpiresAt: "2026-07-29T10:00:00.000Z",
    });
    service.database
      .prepare("UPDATE goals SET active_run_id = ? WHERE id = ?")
      .run(firstAttempt.runId, goalId);
    assert.equal(service.goals.updateStatus(goalId, "running", 2), true);

    const graph = createGoalGraph(service);
    const config = {
      configurable: {
        thread_id: goalThreadId,
        checkpoint_ns: "",
      },
    };
    const beforeResume: Todo[] = [
      { content: "Persist the first checkpoint", status: "completed" },
      { content: "Resume the interrupted goal", status: "in_progress" },
    ];
    await graph.invoke({ todos: beforeResume }, config);
    const firstCheckpoint = await service.checkpointer.getTuple(config);
    assert.ok(firstCheckpoint);
    service.runs.recordCheckpoint(
      firstAttempt.runId,
      firstCheckpoint.checkpoint.id,
    );
    service.runs.saveTodoSnapshot(
      firstAttempt.runId,
      firstCheckpoint.checkpoint.id,
      beforeResume,
    );
    service.toolExecutions.request({
      runId: firstAttempt.runId,
      toolCallId: "inspect-before-resume",
      toolName: "read_file",
      arguments: { path: "README.md" },
      inputHash: "inspect-before-resume-hash",
      effectClass: "read_only",
    });
    service.toolExecutions.transition(
      firstAttempt.runId,
      "inspect-before-resume",
      "succeeded",
      { observed: true },
    );

    const recovered = await service.recovery.recoverExpiredAttempts(
      new Date("2026-07-29T11:00:00.000Z"),
      "process-after-interruption",
    );
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].run.id, firstAttempt.runId);
    assert.equal(recovered[0].recoveryClass, "safe_to_resume");

    const checkpointState = await graph.getState(config);
    assert.deepEqual(
      checkpointState.values.todos,
      beforeResume,
      "LangGraph checkpoint state, not the todo projection, reconstructs the goal",
    );

    const secondAttempt = service.runs.resume({
      runId: firstAttempt.runId,
      processInstanceId: "process-after-interruption",
      leaseExpiresAt: "2026-07-29T12:00:00.000Z",
      allowedRecoveryClasses: ["safe_to_resume"],
    });
    const afterResume: Todo[] = [
      { content: "Persist the first checkpoint", status: "completed" },
      { content: "Resume the interrupted goal", status: "completed" },
    ];
    await graph.invoke({ todos: afterResume }, config);
    const finalCheckpoint = await service.checkpointer.getTuple(config);
    assert.ok(finalCheckpoint);
    assert.notEqual(
      finalCheckpoint.checkpoint.id,
      firstCheckpoint.checkpoint.id,
    );
    service.runs.recordCheckpoint(
      firstAttempt.runId,
      finalCheckpoint.checkpoint.id,
    );
    service.runs.saveTodoSnapshot(
      firstAttempt.runId,
      finalCheckpoint.checkpoint.id,
      afterResume,
    );
    service.toolExecutions.request({
      runId: firstAttempt.runId,
      toolCallId: "inspect-after-resume",
      toolName: "read_file",
      arguments: { path: "package.json" },
      inputHash: "inspect-after-resume-hash",
      effectClass: "read_only",
    });
    service.toolExecutions.transition(
      firstAttempt.runId,
      "inspect-after-resume",
      "succeeded",
      { observed: true },
    );
    service.runs.finish(
      firstAttempt.runId,
      secondAttempt.attemptId,
      "completed",
    );
    assert.equal(service.goals.updateStatus(goalId, "completed", 3), true);

    const run = service.runs.get(firstAttempt.runId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.threadId, goalThreadId);
    assert.notEqual(run?.threadId, session.threadId);
    assert.equal(run?.lastCheckpointId, finalCheckpoint.checkpoint.id);

    const attempts = service.database
      .prepare(`
        SELECT id, run_id, status
        FROM run_attempts
        WHERE run_id = ?
        ORDER BY started_at, rowid
      `)
      .all(firstAttempt.runId) as unknown as Array<{
        id: string;
        run_id: string;
        status: string;
      }>;
    assert.deepEqual(
      attempts.map(({ id, run_id, status }) => ({ id, run_id, status })),
      [
        {
          id: firstAttempt.attemptId,
          run_id: firstAttempt.runId,
          status: "interrupted",
        },
        {
          id: secondAttempt.attemptId,
          run_id: firstAttempt.runId,
          status: "completed",
        },
      ],
    );

    const snapshots = service.database
      .prepare(`
        SELECT checkpoint_id, ordinal, content, status
        FROM todo_snapshots
        WHERE run_id = ?
        ORDER BY observed_at, checkpoint_id, ordinal
      `)
      .all(firstAttempt.runId) as unknown as Array<{
        checkpoint_id: string;
        ordinal: number;
        content: string;
        status: Todo["status"];
      }>;
    assert.equal(snapshots.length, 4);
    assert.deepEqual(
      snapshots
        .filter(
          ({ checkpoint_id }) =>
            checkpoint_id === firstCheckpoint.checkpoint.id,
        )
        .map(({ content, status }) => ({ content, status })),
      beforeResume,
    );
    assert.deepEqual(
      snapshots
        .filter(
          ({ checkpoint_id }) =>
            checkpoint_id === finalCheckpoint.checkpoint.id,
        )
        .map(({ content, status }) => ({ content, status })),
      afterResume,
    );
    assert.deepEqual(
      service.toolExecutions
        .list(firstAttempt.runId)
        .map(({ toolCallId, status }) => ({ toolCallId, status })),
      [
        { toolCallId: "inspect-before-resume", status: "succeeded" },
        { toolCallId: "inspect-after-resume", status: "succeeded" },
      ],
    );

    const goal = service.database
      .prepare(`
        SELECT status, active_run_id, completed_at
        FROM goals
        WHERE id = ?
      `)
      .get(goalId) as {
        status: string;
        active_run_id: string;
        completed_at: string | null;
      };
    assert.equal(goal.status, "completed");
    assert.equal(goal.active_run_id, firstAttempt.runId);
    assert.ok(goal.completed_at);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Future goal integration test passed: one stable run and thread resumed through two attempts with checkpoint-canonical state and projected todo snapshots",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
