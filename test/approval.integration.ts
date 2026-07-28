import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import { VsCodeChatModel } from "../src/vscodeChatModel";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-approval-spike-"));
  const fixture = join(root, "fixture.txt");
  await writeFile(fixture, "one two three\n");

  let requestCount = 0;
  const fakeModel = {
    id: "fake-copilot-approval",
    name: "Fake Copilot Approval",
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
              "edit-one",
              "edit_file",
              {
                file_path: "/fixture.txt",
                old_string: "one",
                new_string: "ONE",
                replace_all: false,
              },
            );
          } else if (turn === 3) {
            yield new vscode.LanguageModelToolCallPart(
              "edit-two",
              "edit_file",
              {
                file_path: "/fixture.txt",
                old_string: "two",
                new_string: "TWO",
                replace_all: false,
              },
            );
          } else if (turn === 5) {
            yield new vscode.LanguageModelToolCallPart(
              "edit-three",
              "edit_file",
              {
                file_path: "/fixture.txt",
                old_string: "three",
                new_string: "THREE",
                replace_all: false,
              },
            );
          } else {
            yield new vscode.LanguageModelTextPart("Edit completed.");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;

  const sessionAllowedTools = new Set<string>();
  const agent = createDeepAgent({
    model: new VsCodeChatModel({ model: fakeModel }),
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    checkpointer: new MemorySaver(),
    interruptOn: {
      edit_file: {
        allowedDecisions: ["approve", "reject"],
        when: ({ toolCall }) => !sessionAllowedTools.has(toolCall.name),
      },
    },
  });
  const config = {
    configurable: { thread_id: "approval-integration" },
  };

  const interrupted = await agent.invoke(
    { messages: [{ role: "user", content: "Edit one" }] },
    config,
  );
  assert.ok(interrupted.__interrupt__?.length, "The first edit should pause for approval");
  assert.equal(
    await readFile(fixture, "utf8"),
    "one two three\n",
    "The file must not change before approval",
  );

  const firstCompleted = await agent.invoke(
    new Command({ resume: { decisions: [{ type: "approve" }] } }),
    config,
  );
  assert.equal(firstCompleted.__interrupt__, undefined);
  assert.equal(await readFile(fixture, "utf8"), "ONE two three\n");

  const interruptedAgain = await agent.invoke(
    { messages: [{ role: "user", content: "Edit two" }] },
    config,
  );
  assert.ok(
    interruptedAgain.__interrupt__?.length,
    "Allow once should require approval again for the next edit",
  );
  assert.equal(await readFile(fixture, "utf8"), "ONE two three\n");

  sessionAllowedTools.add("edit_file");
  const secondCompleted = await agent.invoke(
    new Command({ resume: { decisions: [{ type: "approve" }] } }),
    config,
  );
  assert.equal(secondCompleted.__interrupt__, undefined);
  assert.equal(await readFile(fixture, "utf8"), "ONE TWO three\n");

  const thirdCompleted = await agent.invoke(
    { messages: [{ role: "user", content: "Edit three" }] },
    config,
  );
  assert.equal(
    thirdCompleted.__interrupt__,
    undefined,
    "A session-allowed edit should execute without another interrupt",
  );
  assert.equal(await readFile(fixture, "utf8"), "ONE TWO THREE\n");

  const deniedPath = join(root, "denied.txt");
  let denyRequestCount = 0;
  const denyModel = {
    ...fakeModel,
    id: "fake-copilot-deny",
    async sendRequest() {
      denyRequestCount += 1;
      const turn = denyRequestCount;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              "write-denied",
              "write_file",
              { file_path: "/denied.txt", content: "must not be written" },
            );
          } else {
            yield new vscode.LanguageModelTextPart("The write was denied.");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const denyAgent = createDeepAgent({
    model: new VsCodeChatModel({ model: denyModel }),
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    checkpointer: new MemorySaver(),
    interruptOn: {
      write_file: { allowedDecisions: ["approve", "reject"] },
    },
  });
  const denyConfig = { configurable: { thread_id: "deny-integration" } };
  const writeInterrupted = await denyAgent.invoke(
    { messages: [{ role: "user", content: "Write denied.txt" }] },
    denyConfig,
  );
  assert.ok(writeInterrupted.__interrupt__?.length);
  const rejected = await denyAgent.invoke(
    new Command({
      resume: {
        decisions: [{ type: "reject", message: "Denied for now." }],
      },
    }),
    denyConfig,
  );
  assert.equal(rejected.__interrupt__, undefined);
  await assert.rejects(readFile(deniedPath, "utf8"), { code: "ENOENT" });

  console.log(
    "Approval integration test passed: allow once, allow for session, and deny for now",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
