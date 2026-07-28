import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  Annotation,
  END,
  INTERRUPT,
  START,
  StateGraph,
  interrupt,
  isInterrupted,
} from "@langchain/langgraph";
import {
  DurableContinuationError,
  resumeDurableGraph,
} from "../src/persistence/DurableGraphContinuation";
import { NodeSqliteSaver } from "../src/persistence/NodeSqliteSaver";

const THREAD_ID = "interrupted-continuation-integration";
const MISSING_THREAD_ID = "missing-interrupted-continuation";
const COMPATIBILITY_VERSION = "durable-test-v1";

const State = Annotation.Root({
  values: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  compatibilityVersion: Annotation<string>(),
  approval: Annotation<string>(),
});

function createGraph(saver: NodeSqliteSaver) {
  saver.database.exec(`
    CREATE TABLE IF NOT EXISTS test_step_executions (
      step TEXT PRIMARY KEY,
      executions INTEGER NOT NULL
    )
  `);

  return new StateGraph(State)
    .addNode("prepare", async () => {
      saver.database.prepare(`
        INSERT INTO test_step_executions (step, executions)
        VALUES ('prepare', 1)
        ON CONFLICT(step) DO UPDATE SET executions = executions + 1
      `).run();
      return { values: ["prepared-before-interrupt"] };
    })
    .addNode("awaitApproval", async () => {
      const decision = interrupt({
        kind: "approval",
        question: "Continue the deterministic test?",
      }) as string;
      return {
        approval: decision,
        values: [`resumed-with:${decision}`],
      };
    })
    .addNode("finish", async (state) => ({
      values: [`finished-with:${state.approval}`],
    }))
    .addEdge(START, "prepare")
    .addEdge("prepare", "awaitApproval")
    .addEdge("awaitApproval", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

function config(threadId = THREAD_ID) {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: "",
    },
  };
}

async function runChild(mode: string, databasePath: string): Promise<void> {
  const saver = NodeSqliteSaver.fromPath(databasePath);
  const graph = createGraph(saver);

  try {
    if (mode === "interrupt") {
      const result = await graph.invoke(
        {
          values: ["initial-input"],
          compatibilityVersion: COMPATIBILITY_VERSION,
        },
        config(),
      );
      assert.equal(isInterrupted(result), true);
      assert.equal(
        isInterrupted(result) ? result[INTERRUPT].length : 0,
        1,
      );
      assert.deepEqual(result.values, [
        "initial-input",
        "prepared-before-interrupt",
      ]);

      const snapshot = await graph.getState(config());
      assert.ok(
        snapshot.config.configurable?.checkpoint_id,
        "the interrupt must leave a durable checkpoint",
      );
      assert.deepEqual(snapshot.next, ["awaitApproval"]);
      assert.equal(snapshot.tasks[0]?.interrupts.length, 1);
      assert.equal(stepExecutions(saver), 1);
      return;
    }

    if (mode === "resume") {
      const result = await resumeDurableGraph({
        expectedCompatibilityVersion: COMPATIBILITY_VERSION,
        getState: () => graph.getState(config()),
        invokeResume: (command) => graph.invoke(command, config()),
        resume: "approved-in-fresh-process",
      });

      assert.equal(isInterrupted(result), false);
      assert.equal(result.approval, "approved-in-fresh-process");
      assert.deepEqual(result.values, [
        "initial-input",
        "prepared-before-interrupt",
        "resumed-with:approved-in-fresh-process",
        "finished-with:approved-in-fresh-process",
      ]);
      assert.equal(
        stepExecutions(saver),
        1,
        "a completed checkpointed step must not rerun during continuation",
      );
      return;
    }

    if (mode === "typed-errors") {
      await assertContinuationError(
        () =>
          resumeDurableGraph({
            expectedCompatibilityVersion: COMPATIBILITY_VERSION,
            getState: () => graph.getState(config(MISSING_THREAD_ID)),
            invokeResume: (command) =>
              graph.invoke(command, config(MISSING_THREAD_ID)),
            resume: "unused",
          }),
        "missing_checkpoint",
        null,
      );

      await assertContinuationError(
        () =>
          resumeDurableGraph({
            expectedCompatibilityVersion: "durable-test-v2",
            getState: () => graph.getState(config()),
            invokeResume: (command) => graph.invoke(command, config()),
            resume: "unused",
          }),
        "incompatible_checkpoint",
        COMPATIBILITY_VERSION,
      );
      assert.equal(stepExecutions(saver), 1);
      return;
    }

    throw new Error(`Unknown child mode: ${mode}`);
  } finally {
    saver.close();
  }
}

function stepExecutions(saver: NodeSqliteSaver): number {
  const row = saver.database.prepare(`
    SELECT executions FROM test_step_executions WHERE step = 'prepare'
  `).get() as { executions: number } | undefined;
  return row?.executions ?? 0;
}

async function assertContinuationError(
  action: () => Promise<unknown>,
  code: DurableContinuationError["code"],
  actualCompatibilityVersion: string | null,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DurableContinuationError);
    assert.equal(error.code, code);
    assert.equal(error.recoverable, true);
    assert.equal(
      error.actualCompatibilityVersion,
      actualCompatibilityVersion,
    );
    return true;
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const databasePath = process.argv[3];
  if (mode && databasePath) {
    await runChild(mode, databasePath);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "deepagents-interrupted-run-"));
  const databasePathForTest = join(root, "persistence.sqlite");
  try {
    for (const childMode of ["interrupt", "resume", "typed-errors"]) {
      const result = spawnSync(
        process.execPath,
        [__filename, childMode, databasePathForTest],
        { encoding: "utf8" },
      );
      assert.equal(
        result.status,
        0,
        `${childMode} process failed:\n${result.stderr || result.stdout}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Interrupted continuation integration test passed: a fresh process resumed the durable interrupt without rerunning completed steps, with typed recovery errors",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
