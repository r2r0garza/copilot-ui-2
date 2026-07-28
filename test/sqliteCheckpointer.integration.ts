import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  Annotation,
  END,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { NodeSqliteSaver } from "../src/persistence/NodeSqliteSaver";

const THREAD_ID = "sqlite-checkpointer-integration";
const State = Annotation.Root({
  values: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

function createGraph(saver: NodeSqliteSaver) {
  return new StateGraph(State)
    .addNode("finish", async () => ({}))
    .addEdge(START, "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

async function runChild(mode: string, databasePath: string): Promise<void> {
  const saver = NodeSqliteSaver.fromPath(databasePath);
  const graph = createGraph(saver);
  const config = {
    configurable: {
      thread_id: THREAD_ID,
      checkpoint_ns: "",
    },
  };

  try {
    if (mode === "write") {
      const result = await graph.invoke({ values: ["first"] }, config);
      assert.deepEqual(result.values, ["first"]);
      assert.equal(
        (
          saver.database.prepare("PRAGMA journal_mode").get() as {
            journal_mode: string;
          }
        ).journal_mode,
        "wal",
      );
      assert.equal(
        (
          saver.database.prepare("PRAGMA foreign_keys").get() as {
            foreign_keys: number;
          }
        ).foreign_keys,
        1,
      );
      assert.equal(
        (
          saver.database.prepare("PRAGMA busy_timeout").get() as {
            timeout: number;
          }
        ).timeout,
        5_000,
      );
      assert.equal(
        (
          saver.database.prepare("PRAGMA synchronous").get() as {
            synchronous: number;
          }
        ).synchronous,
        2,
      );
      return;
    }

    if (mode === "resume") {
      const before = await graph.getState(config);
      assert.deepEqual(before.values.values, ["first"]);
      const result = await graph.invoke({ values: ["second"] }, config);
      assert.deepEqual(result.values, ["first", "second"]);
      return;
    }

    if (mode === "delete") {
      await saver.deleteThread(THREAD_ID);
      assert.equal(await saver.getTuple(config), undefined);
      return;
    }

    throw new Error(`Unknown child mode: ${mode}`);
  } finally {
    saver.close();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const databasePath = process.argv[3];
  if (mode && databasePath) {
    await runChild(mode, databasePath);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "deepagents-sqlite-checkpointer-"));
  const path = join(root, "checkpoints.sqlite");
  try {
    for (const childMode of ["write", "resume", "delete"]) {
      const result = spawnSync(process.execPath, [__filename, childMode, path], {
        encoding: "utf8",
      });
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
    "SQLite checkpointer integration test passed: checkpoint persisted, resumed in a fresh process, and deleted",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
