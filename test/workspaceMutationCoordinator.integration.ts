import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolMessage } from "@langchain/core/messages";
import {
  WorkspaceMutationCoordinator,
  type MutationRunHooks,
} from "../src/workspaceMutationCoordinator";

function request(
  id: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    toolCall: { id, name, args, type: "tool_call" as const },
    state: { messages: [] },
    runtime: {},
  };
}

function result(
  id: string,
  name: string,
  content = "ok",
): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: id,
    name,
  });
}

function hooks(expired: string[] = []): MutationRunHooks {
  return {
    onWaiting: () => undefined,
    onRunning: () => undefined,
    onApprovalExpired: (toolCallId) => expired.push(toolCallId),
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-mutations-"));
  try {
    const coordinator = new WorkspaceMutationCoordinator(root, 30);
    const runA = coordinator.createMiddleware({
      runId: "run-a",
      hooks: hooks(),
    });
    const runB = coordinator.createMiddleware({
      runId: "run-b",
      hooks: hooks(),
    });
    assert.ok(runA.wrapToolCall);
    assert.ok(runB.wrapToolCall);

    const fifoOrder: string[] = [];
    let releaseFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const first = runA.wrapToolCall!(
      request("write-a", "write_file", {
        file_path: "a.txt",
        content: "a",
      }) as never,
      (async () => {
        fifoOrder.push("a:start");
        markFirstStarted();
        await firstGate;
        await writeFile(join(root, "a.txt"), "a");
        fifoOrder.push("a:end");
        return result("write-a", "write_file");
      }) as never,
    );
    await firstStarted;
    const second = runB.wrapToolCall!(
      request("write-b", "write_file", {
        file_path: "b.txt",
        content: "b",
      }) as never,
      (async () => {
        fifoOrder.push("b:start");
        await writeFile(join(root, "b.txt"), "b");
        return result("write-b", "write_file");
      }) as never,
    );
    assert.deepEqual(fifoOrder, ["a:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(fifoOrder, ["a:start", "a:end", "b:start"]);

    const shared = join(root, "shared.txt");
    await writeFile(shared, "original");
    for (const [middleware, id] of [
      [runA, "read-a"],
      [runB, "read-b"],
    ] as const) {
      await middleware.wrapToolCall!(
        request(id, "read_file", { file_path: "shared.txt" }) as never,
        (async () => result(id, "read_file", "original")) as never,
      );
    }
    await runA.wrapToolCall!(
      request("edit-a", "edit_file", {
        file_path: "shared.txt",
        old_string: "original",
        new_string: "changed",
      }) as never,
      (async () => {
        await writeFile(shared, "changed");
        return result("edit-a", "edit_file");
      }) as never,
    );
    let staleHandlerCalled = false;
    const staleResult = await runB.wrapToolCall!(
      request("edit-b", "edit_file", {
        file_path: "shared.txt",
        old_string: "original",
        new_string: "stale",
      }) as never,
      (async () => {
        staleHandlerCalled = true;
        return result("edit-b", "edit_file");
      }) as never,
    );
    assert.equal(staleHandlerCalled, false);
    assert.ok(ToolMessage.isInstance(staleResult));
    assert.equal(staleResult.status, "error");
    assert.match(String(staleResult.content), /read_file.*again/i);
    assert.equal(await readFile(shared, "utf8"), "changed");

    const approvalExpired: string[] = [];
    const approvalHooks = hooks(approvalExpired);
    await coordinator.reserveApproval(
      "run-a",
      [{
        toolCallId: "approved-write",
        name: "write_file",
        args: { file_path: "approved.txt", content: "approved" },
      }],
      approvalHooks,
    );
    let queuedExecuted = false;
    const queued = runB.wrapToolCall!(
      request("queued-write", "write_file", {
        file_path: "queued.txt",
        content: "queued",
      }) as never,
      (async () => {
        queuedExecuted = true;
        return result("queued-write", "write_file");
      }) as never,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queuedExecuted, false);
    coordinator.resolveApproval("run-a", ["approved-write"], true);
    await runA.wrapToolCall!(
      request("approved-write", "write_file", {
        file_path: "approved.txt",
        content: "approved",
      }) as never,
      (async () => result("approved-write", "write_file")) as never,
    );
    await queued;
    assert.equal(queuedExecuted, true);
    assert.deepEqual(approvalExpired, []);

    const timeoutExpired: string[] = [];
    await coordinator.reserveApproval(
      "run-a",
      [{
        toolCallId: "timeout-write",
        name: "write_file",
        args: { file_path: "timeout.txt", content: "timeout" },
      }],
      hooks(timeoutExpired),
    );
    let afterTimeoutExecuted = false;
    const afterTimeout = runB.wrapToolCall!(
      request("after-timeout", "write_file", {
        file_path: "after-timeout.txt",
        content: "after",
      }) as never,
      (async () => {
        afterTimeoutExecuted = true;
        return result("after-timeout", "write_file");
      }) as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    await afterTimeout;
    assert.deepEqual(timeoutExpired, ["timeout-write"]);
    assert.equal(afterTimeoutExecuted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Workspace mutation coordinator integration test passed: FIFO, stale-read rejection, approval reservation, and timeout release",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
