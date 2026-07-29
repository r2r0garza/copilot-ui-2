import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import {
  createSteeringMiddleware,
  SteeringQueue,
  type SteeringInjection,
} from "../src/steeringQueue";
import { VsCodeChatModel } from "../src/vscodeChatModel";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "steering-queue-"));
  await writeFile(join(root, "fixture.txt"), "tool completed\n");
  const queue = new SteeringQueue();
  const injections: SteeringInjection[] = [];
  const requests: vscode.LanguageModelChatMessage[][] = [];
  let turn = 0;

  const fakeModel = {
    id: "fake-steering",
    name: "Fake Steering",
    vendor: "copilot",
    family: "fake",
    version: "1",
    maxInputTokens: 32_000,
    async countTokens() {
      return 1;
    },
    async sendRequest(
      messages: vscode.LanguageModelChatMessage[],
    ) {
      requests.push(messages);
      turn += 1;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              "read-before-steering",
              "read_file",
              { file_path: "/fixture.txt" },
            );
          } else {
            yield new vscode.LanguageModelTextPart(
              "Used both steering updates after the read completed.",
            );
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;

  const adapter = new VsCodeChatModel({
    model: fakeModel,
    onEvent: (event) => {
      if (event.kind === "toolCall") {
        queue.enqueue("steer-1", "First, focus on correctness.");
        queue.enqueue("steer-2", "Second, report concise evidence.");
      }
    },
  });
  const agent = createDeepAgent({
    model: adapter,
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    middleware: [
      createSteeringMiddleware(
        queue,
        (injection) => injections.push(injection),
      ),
    ],
  });

  await agent.invoke({
    messages: [{ role: "user", content: "Read the fixture." }],
  });

  assert.equal(requests.length, 2);
  const second = requests[1] ?? [];
  const toolCallIndex = second.findIndex((message) =>
    message.content.some(
      (part) => part instanceof vscode.LanguageModelToolCallPart,
    ),
  );
  const toolResultIndex = second.findIndex((message) =>
    message.content.some(
      (part) => part instanceof vscode.LanguageModelToolResultPart,
    ),
  );
  const steeringIndexes = second
    .map((message, index) => ({
      index,
      text: message.content
        .filter(
          (part): part is vscode.LanguageModelTextPart =>
            part instanceof vscode.LanguageModelTextPart,
        )
        .map((part) => part.value)
        .join("\n"),
    }))
    .filter(({ text }) =>
      text.includes("[Steering update from the user while this run was active]"),
    );

  assert.ok(toolCallIndex >= 0);
  assert.ok(toolResultIndex > toolCallIndex);
  assert.deepEqual(
    steeringIndexes.map(({ index }) => index),
    [toolResultIndex + 1, toolResultIndex + 2],
    "steering messages must be appended only after the matching ToolMessage",
  );
  assert.match(steeringIndexes[0]?.text ?? "", /First, focus on correctness/);
  assert.match(steeringIndexes[1]?.text ?? "", /Second, report concise evidence/);
  assert.deepEqual(
    injections[0]?.entries.map((entry) => entry.id),
    ["steer-1", "steer-2"],
    "multiple steering messages are injected FIFO at one safe boundary",
  );

  const lateQueue = new SteeringQueue();
  const lateRequests: vscode.LanguageModelChatMessage[][] = [];
  let lateTurn = 0;
  const lateModel = {
    ...fakeModel,
    id: "fake-late-steering",
    async sendRequest(messages: vscode.LanguageModelChatMessage[]) {
      lateRequests.push(messages);
      lateTurn += 1;
      return {
        stream: (async function* () {
          if (lateTurn === 1) {
            lateQueue.enqueue(
              "late-steer",
              "This arrived while the final model response was in flight.",
            );
            yield new vscode.LanguageModelTextPart("Initial answer.");
          } else {
            yield new vscode.LanguageModelTextPart("Revised after steering.");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const lateAdapter = new VsCodeChatModel({ model: lateModel });
  const lateAgent = createDeepAgent({
    model: lateAdapter,
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    checkpointer: new MemorySaver(),
    middleware: [
      createSteeringMiddleware(lateQueue, () => undefined),
    ],
  });
  const lateConfig = {
    configurable: { thread_id: "late-steering" },
  };
  await lateAgent.invoke(
    { messages: [{ role: "user", content: "Start." }] },
    lateConfig,
  );
  assert.equal(
    lateQueue.hasPending(),
    true,
    "steering accepted during a final model response waits for another safe boundary",
  );
  await lateAgent.invoke({ messages: [] }, lateConfig);
  assert.match(
    JSON.stringify(lateRequests[1] ?? []),
    /This arrived while the final model response was in flight/,
    "a follow-up invocation should drain late steering before completing the host run",
  );

  console.log(
    "Steering queue integration passed: FIFO updates enter graph state after tool pairing and late final-response steering gets another model boundary",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
