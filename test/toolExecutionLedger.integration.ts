import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolMessage } from "@langchain/core/messages";
import { Command, isCommand } from "@langchain/langgraph";
import { PersistenceService } from "../src/persistence/PersistenceService";
import {
  ToolExecutionBlockedError,
  ToolExecutionIntegrityError,
} from "../src/persistence/ToolExecutionRepository";
import {
  classifyToolEffect,
  createToolExecutionLedgerMiddleware,
  hashToolInput,
} from "../src/toolExecutionLedger";

function uri(fsPath: string) {
  return { fsPath, toString: () => `file://${fsPath}` };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-tool-ledger-"));
  const service = await PersistenceService.open(
    uri(join(root, "storage")),
    uri(join(root, "workspace")),
  );

  try {
    const session = service.sessions.create({
      id: "ledger-session",
      threadId: "ledger-thread",
    });
    const { runId } = service.runs.start({
      id: "ledger-run",
      sessionId: session.id,
      threadId: session.threadId,
      processInstanceId: "ledger-process",
      leaseExpiresAt: "2026-07-28T12:05:00.000Z",
    });
    const middleware = createToolExecutionLedgerMiddleware({
      repository: service.toolExecutions,
      runId,
    });
    assert.ok(middleware.wrapToolCall);
    assert.equal(classifyToolEffect("read_file"), "read_only");
    assert.equal(classifyToolEffect("write_file"), "non_idempotent");
    assert.equal(classifyToolEffect("edit_file"), "non_idempotent");
    assert.equal(classifyToolEffect("execute_command"), "non_idempotent");
    assert.equal(
      hashToolInput({ first: 1, second: 2 }),
      hashToolInput({ second: 2, first: 1 }),
    );

    let readExecutions = 0;
    const readRequest = request("read-1", "read_file", { path: "README.md" });
    const readHandler = async () => {
      readExecutions += 1;
      return new ToolMessage({
        content: "durable contents",
        tool_call_id: "read-1",
        name: "read_file",
      });
    };
    const firstRead = await middleware.wrapToolCall!(
      readRequest as never,
      readHandler as never,
    );
    const replayedRead = await middleware.wrapToolCall!(
      readRequest as never,
      readHandler as never,
    );
    assert.equal(readExecutions, 1);
    assert.ok(ToolMessage.isInstance(firstRead));
    assert.ok(ToolMessage.isInstance(replayedRead));
    assert.equal(replayedRead.content, "durable contents");
    assert.equal(
      service.toolExecutions.get(runId, "read-1")?.status,
      "succeeded",
    );

    await assert.rejects(
      async () =>
        middleware.wrapToolCall!(
          request("read-1", "read_file", { path: "different.md" }) as never,
          readHandler as never,
        ),
      ToolExecutionIntegrityError,
    );
    assert.equal(readExecutions, 1);

    let commandExecutions = 0;
    const commandRequest = request("write-1", "write_file", {
      path: "result.txt",
      content: "hello",
    });
    const commandHandler = async () => {
      commandExecutions += 1;
      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: "Wrote result.txt",
              tool_call_id: "write-1",
              name: "write_file",
            }),
          ],
        },
      });
    };
    const firstCommand = await middleware.wrapToolCall!(
      commandRequest as never,
      commandHandler as never,
    );
    const replayedCommand = await middleware.wrapToolCall!(
      commandRequest as never,
      commandHandler as never,
    );
    assert.ok(isCommand(firstCommand));
    assert.ok(isCommand(replayedCommand));
    assert.equal(commandExecutions, 1);
    assert.ok(
      ToolMessage.isInstance(
        (replayedCommand.update as { messages: unknown[] }).messages[0],
      ),
    );

    let successfulCommandExecutions = 0;
    const successfulCommandRequest = request(
      "command-success",
      "execute_command",
      { executable: "node", args: ["--version"] },
    );
    const successfulCommandHandler = async () => {
      successfulCommandExecutions += 1;
      return new ToolMessage({
        content: "stdout: v22.0.0",
        tool_call_id: "command-success",
        name: "execute_command",
      });
    };
    await middleware.wrapToolCall!(
      successfulCommandRequest as never,
      successfulCommandHandler as never,
    );
    const replayedSuccessfulCommand = await middleware.wrapToolCall!(
      successfulCommandRequest as never,
      successfulCommandHandler as never,
    );
    assert.equal(successfulCommandExecutions, 1);
    assert.ok(ToolMessage.isInstance(replayedSuccessfulCommand));
    assert.equal(replayedSuccessfulCommand.content, "stdout: v22.0.0");

    let failedExecutions = 0;
    const failedRequest = request("command-1", "execute_command", {
      executable: "false",
      args: [],
    });
    const failedHandler = async () => {
      failedExecutions += 1;
      throw new Error("command failed once");
    };
    const firstFailure = await middleware.wrapToolCall!(
      failedRequest as never,
      failedHandler as never,
    );
    const replayedFailure = await middleware.wrapToolCall!(
      failedRequest as never,
      failedHandler as never,
    );
    assert.equal(failedExecutions, 1);
    assert.ok(ToolMessage.isInstance(firstFailure));
    assert.ok(ToolMessage.isInstance(replayedFailure));
    assert.equal(replayedFailure.status, "error");
    assert.match(String(replayedFailure.content), /command failed once/);
    assert.equal(
      service.toolExecutions.get(runId, "command-1")?.status,
      "failed",
    );

    const uncertainArgs = { path: "uncertain.txt" };
    service.toolExecutions.request({
      runId,
      toolCallId: "uncertain-edit",
      toolName: "edit_file",
      arguments: uncertainArgs,
      inputHash: hashToolInput(uncertainArgs),
      effectClass: "non_idempotent",
    });
    service.toolExecutions.prepareExecution(
      runId,
      "uncertain-edit",
      "edit_file",
      hashToolInput(uncertainArgs),
    );
    service.toolExecutions.markRunningUncertain(runId);
    assert.throws(
      () =>
        service.toolExecutions.prepareExecution(
          runId,
          "uncertain-edit",
          "edit_file",
          hashToolInput(uncertainArgs),
        ),
      ToolExecutionBlockedError,
    );

    const uncertainReadArgs = { path: "retry.txt" };
    service.toolExecutions.request({
      runId,
      toolCallId: "uncertain-read",
      toolName: "read_file",
      arguments: uncertainReadArgs,
      inputHash: hashToolInput(uncertainReadArgs),
      effectClass: "read_only",
    });
    service.toolExecutions.prepareExecution(
      runId,
      "uncertain-read",
      "read_file",
      hashToolInput(uncertainReadArgs),
    );
    service.toolExecutions.markRunningUncertain(runId);
    assert.equal(service.toolExecutions.authorizeReadOnlyRetries(runId), 1);
    assert.equal(
      service.toolExecutions.prepareExecution(
        runId,
        "uncertain-read",
        "read_file",
        hashToolInput(uncertainReadArgs),
      ).kind,
      "execute",
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Tool execution ledger integration test passed: exact-once replay, input integrity, terminal failures, uncertain blocking, and explicit read retry",
  );
}

function request(
  id: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    toolCall: { id, name, args, type: "tool_call" as const },
    tool: undefined,
    state: { messages: [] },
    runtime: {},
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
