import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import { createExecuteCommandTool } from "../src/executeCommandTool";
import { VsCodeChatModel, type AdapterEvent } from "../src/vscodeChatModel";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-command-spike-"));
  const deniedPath = join(root, "must-not-exist.txt");
  let requestCount = 0;

  const fakeModel = {
    id: "fake-copilot-command",
    name: "Fake Copilot Command",
    vendor: "copilot",
    family: "fake",
    version: "1",
    maxInputTokens: 32_000,
    async countTokens() {
      return 1;
    },
    async sendRequest() {
      requestCount += 1;
      const turn = requestCount;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              "approved-command",
              "execute_command",
              {
                executable: process.execPath,
                args: ["-e", "console.log('approved command output')"],
                timeout_seconds: 10,
              },
            );
          } else if (turn === 3) {
            yield new vscode.LanguageModelToolCallPart(
              "session-command",
              "execute_command",
              {
                executable: process.execPath,
                args: ["-e", "console.log('session command output')"],
                timeout_seconds: 10,
              },
            );
          } else {
            yield new vscode.LanguageModelTextPart("Command turn completed.");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;

  const events: AdapterEvent[] = [];
  const sessionAllowedTools = new Set<string>();
  const agent = createDeepAgent({
    model: new VsCodeChatModel({
      model: fakeModel,
      onEvent: (event) => events.push(event),
    }),
    tools: [createExecuteCommandTool({ workspaceRoot: root })],
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    checkpointer: new MemorySaver(),
    interruptOn: {
      execute_command: {
        allowedDecisions: ["approve", "reject"],
        when: ({ toolCall }) => !sessionAllowedTools.has(toolCall.name),
      },
    },
  });
  const config = { configurable: { thread_id: "command-integration" } };

  const firstInterrupted = await agent.invoke(
    { messages: [{ role: "user", content: "Run a command" }] },
    config,
  );
  assert.ok(firstInterrupted.__interrupt__?.length);

  sessionAllowedTools.add("execute_command");
  const approved = await agent.invoke(
    new Command({ resume: { decisions: [{ type: "approve" }] } }),
    config,
  );
  assert.equal(approved.__interrupt__, undefined);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "toolResult" &&
        event.text.includes("approved command output"),
    ),
    "Approved command output should return through the Deep Agents tool loop",
  );

  const sessionCompleted = await agent.invoke(
    { messages: [{ role: "user", content: "Run another command" }] },
    config,
  );
  assert.equal(
    sessionCompleted.__interrupt__,
    undefined,
    "A session-allowed command should execute without another interrupt",
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "toolResult" &&
        event.text.includes("session command output"),
    ),
  );

  let denyRequestCount = 0;
  const denyModel = {
    ...fakeModel,
    id: "fake-copilot-command-deny",
    async sendRequest() {
      denyRequestCount += 1;
      const turn = denyRequestCount;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              "denied-command",
              "execute_command",
              {
                executable: process.execPath,
                args: [
                  "-e",
                  "require('node:fs').writeFileSync('must-not-exist.txt', 'bad')",
                ],
                timeout_seconds: 10,
              },
            );
          } else {
            yield new vscode.LanguageModelTextPart("Command denied.");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const denyAgent = createDeepAgent({
    model: new VsCodeChatModel({ model: denyModel }),
    tools: [createExecuteCommandTool({ workspaceRoot: root })],
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    checkpointer: new MemorySaver(),
    interruptOn: {
      execute_command: { allowedDecisions: ["approve", "reject"] },
    },
  });
  const denyConfig = { configurable: { thread_id: "command-deny-integration" } };
  const denyInterrupted = await denyAgent.invoke(
    { messages: [{ role: "user", content: "Run a denied command" }] },
    denyConfig,
  );
  assert.ok(denyInterrupted.__interrupt__?.length);
  const rejected = await denyAgent.invoke(
    new Command({
      resume: {
        decisions: [{ type: "reject", message: "Command denied for now." }],
      },
    }),
    denyConfig,
  );
  assert.equal(rejected.__interrupt__, undefined);
  await assert.rejects(access(deniedPath), { code: "ENOENT" });

  console.log(
    "Command integration test passed: session approval, output capture, and deny-before-execute",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
