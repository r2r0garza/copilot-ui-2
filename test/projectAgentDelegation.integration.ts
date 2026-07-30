import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, MemorySaver } from "@langchain/langgraph";
import {
  createDeepAgent,
  createSubAgentMiddleware,
  FilesystemBackend,
  type CompiledSubAgent,
} from "deepagents";
import * as vscode from "vscode";
import {
  createAgentToolPolicyMiddleware,
  resolveAgentToolPolicy,
} from "../src/agentToolPolicy";
import { configureDeepAgentSystemPrompt } from "../src/deepAgentSystemPrompt";
import { PersistenceService } from "../src/persistence/PersistenceService";
import {
  createProjectAgentDelegationGuardMiddleware,
  PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
  PROJECT_AGENT_TASK_DESCRIPTION,
} from "../src/projectAgentDelegation";
import {
  classifyToolEffect,
  createToolExecutionLedgerMiddleware,
  hashToolInput,
} from "../src/toolExecutionLedger";
import { VsCodeChatModel, type AdapterEvent } from "../src/vscodeChatModel";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "project-agent-delegation-"));
  await writeFile(join(root, "fixture.txt"), "delegated fixture\n");

  const requests: vscode.LanguageModelChatRequestOptions[] = [];
  const events: AdapterEvent[] = [];
  let requestCount = 0;
  const fakeModel = {
    id: "fake-project-agent-delegation",
    name: "Fake Project Agent Delegation",
    vendor: "copilot",
    family: "fake",
    version: "1",
    maxInputTokens: 32_000,
    async countTokens() {
      return 1;
    },
    async sendRequest(
      _messages: vscode.LanguageModelChatMessage[],
      options: vscode.LanguageModelChatRequestOptions = {},
    ) {
      requests.push(options);
      requestCount += 1;
      const turn = requestCount;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              "delegate-allowed",
              "task",
              {
                description: "Read /fixture.txt and report its contents.",
                subagent_type: "reader-child",
              },
            );
          } else if (turn === 2) {
            yield new vscode.LanguageModelToolCallPart(
              "child-read",
              "read_file",
              { file_path: "/fixture.txt" },
            );
          } else if (turn === 3) {
            yield new vscode.LanguageModelTextPart(
              "reader-child-result: delegated fixture",
            );
          } else {
            yield new vscode.LanguageModelTextPart(
              "parent-result: reader-child-result",
            );
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const adapter = new VsCodeChatModel({
    model: fakeModel,
    onEvent: (event) => events.push(event),
  });
  const backend = new FilesystemBackend({ rootDir: root, virtualMode: true });
  const child = createDeepAgent({
    model: adapter,
    name: "reader-child",
    backend,
    middleware: [
      createSubAgentMiddleware({
        defaultModel: adapter,
        subagents: [],
        generalPurposeAgent: false,
        systemPrompt: PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
        taskDescription: PROJECT_AGENT_TASK_DESCRIPTION,
      }),
      createProjectAgentDelegationGuardMiddleware([]),
      createAgentToolPolicyMiddleware(resolveAgentToolPolicy(["read"])),
    ],
    systemPrompt: configureDeepAgentSystemPrompt(
      "You are the bounded reader child.",
      false,
    ),
  });
  const compiledChild: CompiledSubAgent = {
    name: "reader-child",
    description: "Reads files without editing them.",
    runnable: child,
  };
  const parent = createDeepAgent({
    model: adapter,
    name: "delegation-parent",
    backend,
    middleware: [
      createSubAgentMiddleware({
        defaultModel: adapter,
        subagents: [compiledChild],
        generalPurposeAgent: false,
        systemPrompt: PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
        taskDescription: PROJECT_AGENT_TASK_DESCRIPTION,
      }),
      createProjectAgentDelegationGuardMiddleware(["reader-child"]),
      createAgentToolPolicyMiddleware(resolveAgentToolPolicy(["agent"])),
    ],
    systemPrompt: configureDeepAgentSystemPrompt(
      "Delegate reading work to the configured child.",
      false,
    ),
  });

  await parent.invoke({
    messages: [{ role: "user", content: "Delegate this read." }],
  });

  assert.deepEqual(
    requests[0]?.tools?.map((tool) => tool.name).sort(),
    ["glob", "grep", "ls", "read_file", "task", "write_todos"],
    "the parent should expose the universal baseline and task",
  );
  const taskTool = requests[0]?.tools?.find((tool) => tool.name === "task");
  assert.match(
    JSON.stringify(taskTool),
    /reader-child/,
    "the task schema should advertise the allowed child",
  );
  assert.doesNotMatch(
    JSON.stringify(taskTool),
    /general-purpose/,
    "the implicit general-purpose child must not be exposed",
  );
  assert.deepEqual(
    requests[1]?.tools?.map((tool) => tool.name).sort(),
    ["glob", "grep", "ls", "read_file", "write_todos"],
    "the delegated child should receive the universal baseline",
  );
  assert.equal(requests[2]?.tools?.some((tool) => tool.name === "task"), false);
  assert.deepEqual(
    events
      .filter((event) => event.kind === "toolCall")
      .map((event) => event.name),
    ["task", "read_file"],
    "delegation and child activity should both remain visible to the shared event ledger",
  );

  const forcedRequests: vscode.LanguageModelChatMessage[][] = [];
  let forcedTurn = 0;
  const forcedModel = {
    ...fakeModel,
    id: "fake-forced-project-agent-delegation",
    async sendRequest(
      messages: vscode.LanguageModelChatMessage[],
    ) {
      forcedRequests.push(messages);
      forcedTurn += 1;
      return {
        stream: (async function* () {
          if (forcedTurn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              "delegate-forbidden",
              "task",
              {
                description: "Try a hidden child.",
                subagent_type: "forbidden-child",
              },
            );
          } else {
            yield new vscode.LanguageModelTextPart("Forbidden child blocked.");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const forcedAdapter = new VsCodeChatModel({ model: forcedModel });
  const forcedParent = createDeepAgent({
    model: forcedAdapter,
    backend,
    middleware: [
      createSubAgentMiddleware({
        defaultModel: forcedAdapter,
        subagents: [compiledChild],
        generalPurposeAgent: false,
        systemPrompt: PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
        taskDescription: PROJECT_AGENT_TASK_DESCRIPTION,
      }),
      createProjectAgentDelegationGuardMiddleware(["reader-child"]),
      createAgentToolPolicyMiddleware(resolveAgentToolPolicy(["agent"])),
    ],
  });
  await forcedParent.invoke({
    messages: [{ role: "user", content: "Force the forbidden child." }],
  });
  assert.match(
    JSON.stringify(forcedRequests[1] ?? []),
    /not available for delegation.*reader-child/,
    "a forced child ID must fail before any forbidden child can run",
  );

  const approvalPath = join(root, "delegated-approval.txt");
  const approvalPersistence = await PersistenceService.open(
    {
      fsPath: join(root, "approval-storage"),
      toString: () => `file://${join(root, "approval-storage")}`,
    },
    {
      fsPath: root,
      toString: () => `file://${root}`,
    },
  );
  const approvalSession = approvalPersistence.sessions.create({
    id: "delegated-approval-session",
    threadId: "delegated-approval",
  });
  const { runId: approvalRunId } = approvalPersistence.runs.start({
    id: "delegated-approval-run",
    sessionId: approvalSession.id,
    threadId: approvalSession.threadId,
    processInstanceId: "delegation-test",
    leaseExpiresAt: "2026-07-29T12:05:00.000Z",
  });
  let approvalTurn = 0;
  const approvalModel = {
    ...fakeModel,
    id: "fake-delegated-approval",
    async sendRequest() {
      approvalTurn += 1;
      const turn = approvalTurn;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              "delegate-writer",
              "task",
              {
                description: "Create /delegated-approval.txt.",
                subagent_type: "writer-child",
              },
            );
          } else if (turn === 2) {
            yield new vscode.LanguageModelToolCallPart(
              "child-write",
              "write_file",
              {
                file_path: "/delegated-approval.txt",
                content: "approved child write\n",
              },
            );
          } else if (turn === 3) {
            yield new vscode.LanguageModelTextPart("Child write complete.");
          } else {
            yield new vscode.LanguageModelTextPart("Delegated write complete.");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const approvalAdapter = new VsCodeChatModel({
    model: approvalModel,
    onEvent: (event) => {
      if (event.kind !== "toolCall") {
        return;
      }
      approvalPersistence.toolExecutions.request({
        runId: approvalRunId,
        toolCallId: event.id,
        toolName: event.name,
        arguments: event.input,
        inputHash: hashToolInput(event.input),
        effectClass: classifyToolEffect(event.name),
      });
    },
  });
  const writerChild = createDeepAgent({
    model: approvalAdapter,
    backend,
    middleware: [
      createSubAgentMiddleware({
        defaultModel: approvalAdapter,
        subagents: [],
        generalPurposeAgent: false,
        systemPrompt: PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
        taskDescription: PROJECT_AGENT_TASK_DESCRIPTION,
      }),
      createProjectAgentDelegationGuardMiddleware([]),
      createAgentToolPolicyMiddleware(resolveAgentToolPolicy(["edit"])),
      createToolExecutionLedgerMiddleware({
        repository: approvalPersistence.toolExecutions,
        runId: approvalRunId,
      }),
    ],
    interruptOn: { write_file: true },
  });
  const approvalParent = createDeepAgent({
    model: approvalAdapter,
    backend,
    checkpointer: new MemorySaver(),
    middleware: [
      createSubAgentMiddleware({
        defaultModel: approvalAdapter,
        subagents: [
          {
            name: "writer-child",
            description: "Writes approved files.",
            runnable: writerChild,
          },
        ],
        generalPurposeAgent: false,
        systemPrompt: PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
        taskDescription: PROJECT_AGENT_TASK_DESCRIPTION,
      }),
      createProjectAgentDelegationGuardMiddleware(["writer-child"]),
      createAgentToolPolicyMiddleware(resolveAgentToolPolicy(["agent"])),
      createToolExecutionLedgerMiddleware({
        repository: approvalPersistence.toolExecutions,
        runId: approvalRunId,
      }),
    ],
  });
  const approvalConfig = {
    configurable: { thread_id: "delegated-approval" },
  };
  const interrupted = await approvalParent.invoke(
    { messages: [{ role: "user", content: "Delegate a file write." }] },
    approvalConfig,
  );
  assert.ok(
    interrupted.__interrupt__?.length,
    "an approval-gated child tool should interrupt the parent run",
  );
  await assert.rejects(readFile(approvalPath, "utf8"), { code: "ENOENT" });
  const approvalWrite = approvalPersistence.toolExecutions
    .list(approvalRunId)
    .find((record) => record.toolName === "write_file");
  assert.ok(approvalWrite);
  assert.equal(
    approvalWrite.status,
    "requested",
    "the production ledger must preserve an approval interrupt as resumable control flow",
  );
  approvalPersistence.toolExecutions.transition(
    approvalRunId,
    approvalWrite.toolCallId,
    "waiting_approval",
  );
  approvalPersistence.toolExecutions.transition(
    approvalRunId,
    approvalWrite.toolCallId,
    "approved",
  );
  const resumed = await approvalParent.invoke(
    new Command({ resume: { decisions: [{ type: "approve" }] } }),
    approvalConfig,
  );
  assert.equal(resumed.__interrupt__, undefined);
  assert.equal(await readFile(approvalPath, "utf8"), "approved child write\n");
  approvalPersistence.close();

  let childStartedResolve: (() => void) | undefined;
  const childStarted = new Promise<void>((resolve) => {
    childStartedResolve = resolve;
  });
  let cancellationTurn = 0;
  let childCancellationObserved = false;
  const cancellationModel = {
    ...fakeModel,
    id: "fake-delegated-cancellation",
    async sendRequest(
      _messages: vscode.LanguageModelChatMessage[],
      _options: vscode.LanguageModelChatRequestOptions,
      token: vscode.CancellationToken,
    ) {
      cancellationTurn += 1;
      if (cancellationTurn === 1) {
        return {
          stream: (async function* () {
            yield new vscode.LanguageModelToolCallPart(
              "delegate-slow",
              "task",
              {
                description: "Wait until cancelled.",
                subagent_type: "slow-child",
              },
            );
          })(),
          text: (async function* () {})(),
        };
      }
      childStartedResolve?.();
      return new Promise((_, reject) => {
        token.onCancellationRequested(() => {
          childCancellationObserved = true;
          reject(new vscode.CancellationError());
        });
      });
    },
  } as vscode.LanguageModelChat;
  const cancellationAdapter = new VsCodeChatModel({
    model: cancellationModel,
  });
  const slowChild = createDeepAgent({
    model: cancellationAdapter,
    backend,
    middleware: [
      createSubAgentMiddleware({
        defaultModel: cancellationAdapter,
        subagents: [],
        generalPurposeAgent: false,
        systemPrompt: PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
        taskDescription: PROJECT_AGENT_TASK_DESCRIPTION,
      }),
      createProjectAgentDelegationGuardMiddleware([]),
      createAgentToolPolicyMiddleware(resolveAgentToolPolicy([])),
    ],
  });
  const cancellationParent = createDeepAgent({
    model: cancellationAdapter,
    backend,
    middleware: [
      createSubAgentMiddleware({
        defaultModel: cancellationAdapter,
        subagents: [
          {
            name: "slow-child",
            description: "Waits for cancellation.",
            runnable: slowChild,
          },
        ],
        generalPurposeAgent: false,
        systemPrompt: PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
        taskDescription: PROJECT_AGENT_TASK_DESCRIPTION,
      }),
      createProjectAgentDelegationGuardMiddleware(["slow-child"]),
      createAgentToolPolicyMiddleware(resolveAgentToolPolicy(["agent"])),
    ],
  });
  const controller = new AbortController();
  const cancellationRun = cancellationParent.invoke(
    { messages: [{ role: "user", content: "Delegate slow work." }] },
    { signal: controller.signal },
  );
  await childStarted;
  controller.abort();
  await assert.rejects(
    cancellationRun,
    (error) =>
      error instanceof vscode.CancellationError ||
      (error instanceof Error && error.name === "AbortError"),
    "parent cancellation should reach an active child model request",
  );
  assert.equal(
    childCancellationObserved,
    true,
    "the delegated child should observe cancellation through its VS Code token",
  );

  console.log(
    "Project agent delegation integration passed: allowlisted task routing, child tool bounds, forced-call defense, replay events, approvals, and cancellation",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
