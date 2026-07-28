import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@langchain/langgraph";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import { PersistenceService } from "../src/persistence/PersistenceService";
import { projectConversationEvents } from "../src/persistence/ConversationReplayProjection";
import {
  classifyToolEffect,
  createToolExecutionLedgerMiddleware,
  hashToolInput,
} from "../src/toolExecutionLedger";
import { VsCodeChatModel } from "../src/vscodeChatModel";

function uri(fsPath: string) {
  return { fsPath, toString: () => `file://${fsPath}` };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-pending-approval-"));
  const storage = join(root, "storage");
  const workspace = join(root, "workspace");
  const sessionId = "approval-restart-session";
  const threadId = "approval-restart-thread";
  const runId = "approval-restart-run";
  const toolCallId = "approval-restart-write";
  const toolArgs = {
    file_path: "/restored-approval.txt",
    content: "approved after restart",
  };

  const first = await PersistenceService.open(uri(storage), uri(workspace));
  try {
    first.sessions.create({ id: sessionId, threadId });
    first.runs.start({
      id: runId,
      sessionId,
      threadId,
      modelKey: "copilot:restart-model",
      processInstanceId: "process-before-restart",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    first.conversationEvents.append({
      sessionId,
      runId,
      eventType: "user_message",
      payload: { schemaVersion: 1, content: "Write the restart fixture." },
    });

    const interruptedAgent = createAgent({
      service: first,
      workspace,
      runId,
      model: toolCallingModel(toolCallId, toolArgs),
      onToolCall: (id, name, args) => {
        first.toolExecutions.request({
          runId,
          toolCallId: id,
          toolName: name,
          arguments: args,
          inputHash: hashToolInput(args),
          effectClass: classifyToolEffect(name),
        });
      },
    });
    const config = {
      configurable: { thread_id: threadId, checkpoint_ns: "" },
    };
    const interrupted = await interruptedAgent.invoke(
      { messages: [{ role: "user", content: "Write the restart fixture." }] },
      config,
    );
    assert.ok(interrupted.__interrupt__?.length);
    first.toolExecutions.transition(
      runId,
      toolCallId,
      "waiting_approval",
    );
    first.runs.setExecutionStatus(runId, "waiting_approval");
    first.conversationEvents.append({
      sessionId,
      runId,
      eventType: "approval_requested",
      payload: {
        schemaVersion: 1,
        requestId: "restored-request",
        toolName: "write_file",
        input: toolArgs,
      },
    });
    await assert.rejects(access(join(workspace, "restored-approval.txt")), {
      code: "ENOENT",
    });
  } finally {
    first.close();
  }

  const second = await PersistenceService.open(uri(storage), uri(workspace));
  try {
    const recovered = await second.recovery.recoverExpiredAttempts(
      new Date("2026-07-28T12:00:00.000Z"),
      "process-after-restart",
    );
    assert.equal(recovered[0]?.recoveryClass, "waiting_for_approval");
    const pending = projectConversationEvents(
      second.conversationEvents.list(sessionId),
    ).find((item) => item.kind === "approval_requested");
    assert.equal(pending?.kind, "approval_requested");
    if (pending?.kind === "approval_requested") {
      assert.equal(pending.status, "pending");
      assert.equal(pending.grantsAuthority, false);
    }

    const interrupts = await second.recovery.getPendingInterrupts(runId);
    const actionRequests = approvalActions(interrupts);
    assert.deepEqual(actionRequests, [
      { name: "write_file", args: toolArgs },
    ]);

    const resumed = second.runs.resume({
      runId,
      processInstanceId: "process-after-restart",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      allowedRecoveryClasses: ["waiting_for_approval"],
    });
    second.toolExecutions.setEffectClass(
      runId,
      toolCallId,
      "idempotent_write",
    );
    second.toolExecutions.transition(runId, toolCallId, "approved");
    second.approvals.record({
      sessionId,
      runId,
      toolCallId,
      toolName: "write_file",
      decision: "session",
      processInstanceId: "process-after-restart",
    });
    second.conversationEvents.append({
      sessionId,
      runId,
      eventType: "approval_resolved",
      payload: {
        schemaVersion: 1,
        requestId: "restored-request",
        decision: "session",
      },
    });

    const resumedAgent = createAgent({
      service: second,
      workspace,
      runId,
      model: textModel("Recovered write completed."),
    });
    const result = await resumedAgent.invoke(
      new Command({
        resume: { decisions: [{ type: "approve" }] },
      }),
      { configurable: { thread_id: threadId, checkpoint_ns: "" } },
    );
    assert.equal(result.__interrupt__, undefined);
    assert.equal(
      await readFile(join(workspace, "restored-approval.txt"), "utf8"),
      "approved after restart",
    );
    assert.equal(
      second.toolExecutions.get(runId, toolCallId)?.status,
      "succeeded",
    );
    second.runs.finish(runId, resumed.attemptId, "completed");
  } finally {
    second.close();
  }

  const third = await PersistenceService.open(uri(storage), uri(workspace));
  try {
    const futureRun = third.runs.start({
      id: "future-run",
      sessionId,
      threadId: "future-thread",
      modelKey: "copilot:restart-model",
      processInstanceId: "third-process",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const futureAgent = createAgent({
      service: third,
      workspace,
      runId: futureRun.runId,
      model: toolCallingModel("future-write", {
        file_path: "/must-be-approved-again.txt",
        content: "new process",
      }),
      onToolCall: (id, name, args) => {
        third.toolExecutions.request({
          runId: futureRun.runId,
          toolCallId: id,
          toolName: name,
          arguments: args,
          inputHash: hashToolInput(args),
          effectClass: classifyToolEffect(name),
        });
      },
    });
    const future = await futureAgent.invoke(
      { messages: [{ role: "user", content: "Write another file." }] },
      { configurable: { thread_id: "future-thread", checkpoint_ns: "" } },
    );
    assert.ok(
      future.__interrupt__?.length,
      "A persisted session decision must not authorize a future process.",
    );
    await assert.rejects(
      access(join(workspace, "must-be-approved-again.txt")),
      { code: "ENOENT" },
    );
  } finally {
    third.close();
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Pending approval recovery integration test passed: checkpoint review resumes safely and session authority expires across processes",
  );
}

function createAgent(input: {
  service: PersistenceService;
  workspace: string;
  runId: string;
  model: vscode.LanguageModelChat;
  onToolCall?: (
    id: string,
    name: string,
    args: Record<string, unknown>,
  ) => void;
}) {
  return createDeepAgent({
    model: new VsCodeChatModel({
      model: input.model,
      onEvent: (event) => {
        if (event.kind === "toolCall") {
          input.onToolCall?.(
            event.id,
            event.name,
            event.input as Record<string, unknown>,
          );
        }
      },
    }),
    backend: new FilesystemBackend({
      rootDir: input.workspace,
      virtualMode: true,
    }),
    checkpointer: input.service.checkpointer,
    middleware: [
      createToolExecutionLedgerMiddleware({
        repository: input.service.toolExecutions,
        runId: input.runId,
      }),
    ],
    interruptOn: {
      write_file: {
        allowedDecisions: ["approve", "reject"],
        when: () => true,
      },
    },
  });
}

function toolCallingModel(
  toolCallId: string,
  args: Record<string, unknown>,
): vscode.LanguageModelChat {
  return {
    id: "restart-model",
    name: "Restart model",
    vendor: "copilot",
    family: "fake",
    version: "1",
    maxInputTokens: 32_000,
    async countTokens() {
      return 1;
    },
    async sendRequest() {
      return {
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart(
            toolCallId,
            "write_file",
            args,
          );
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
}

function textModel(text: string): vscode.LanguageModelChat {
  return {
    ...toolCallingModel("unused", {}),
    async sendRequest() {
      return {
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart(text);
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
}

function approvalActions(
  interrupts: unknown[],
): Array<{ name: string; args: Record<string, unknown> }> {
  const value = (interrupts[0] as { value?: unknown })?.value;
  if (!value || typeof value !== "object" || !("actionRequests" in value)) {
    return [];
  }
  const actions = (value as { actionRequests?: unknown }).actionRequests;
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions.map((action) => {
    const record = action as {
      name: string;
      args: Record<string, unknown>;
    };
    return { name: record.name, args: record.args };
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
