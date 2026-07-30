import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  createDeepAgent,
  createSummarizationMiddleware,
  FilesystemBackend,
} from "deepagents";
import * as vscode from "vscode";
import { configureDeepAgentSystemPrompt } from "../src/deepAgentSystemPrompt";
import {
  VsCodeChatModel,
  type ModelPromptSnapshot,
} from "../src/vscodeChatModel";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-vscode-spike-"));
  await writeFile(join(root, "fixture.txt"), "adapter integration works\n");

  const requests: Array<{
    messages: vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }> = [];

  const fakeModel = {
    id: "fake-copilot",
    name: "Fake Copilot",
    vendor: "copilot",
    family: "fake",
    version: "1",
    maxInputTokens: 32_000,
    async countTokens() {
      return 1;
    },
    async sendRequest(
      messages: vscode.LanguageModelChatMessage[],
      options: vscode.LanguageModelChatRequestOptions = {},
    ) {
      requests.push({ messages, options });
      const turn = requests.length;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              "read-fixture",
              "read_file",
              { file_path: "/fixture.txt" },
            );
          } else {
            yield new vscode.LanguageModelTextPart("I read: adapter integration works");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;

  const events: string[] = [];
  const prompts: Array<{ systemPrompt: string; userPrompt: string }> = [];
  const seenToolResults = new Set<string>();
  const adapter = new VsCodeChatModel({
    model: fakeModel,
    onEvent: (event) => events.push(event.kind),
    onPrompt: (snapshot) => prompts.push(snapshot),
    seenToolResults,
  });
  const agent = createDeepAgent({
    model: adapter,
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    systemPrompt: configureDeepAgentSystemPrompt(
      "Read the requested file before answering.",
      false,
    ),
  });

  const result = await agent.invoke({
    messages: [{ role: "user", content: "Read /fixture.txt" }],
  });
  const final = [...result.messages].reverse().find((message) => AIMessage.isInstance(message));

  assert.equal(requests.length, 2, "Deep Agents should make a second model request after the tool result");
  assert.ok(
    requests[0].options.tools?.some((tool) => tool.name === "read_file"),
    "Deep Agents' private read_file tool should be passed to vscode.lm",
  );
  const firstPrompt = requests[0].messages[0]?.content
    .filter((part): part is vscode.LanguageModelTextPart =>
      part instanceof vscode.LanguageModelTextPart,
    )
    .map((part) => part.value)
    .join("\n");
  assert.match(firstPrompt ?? "", /<custom_instructions>/);
  assert.match(firstPrompt ?? "", /<\/custom_instructions>/);
  assert.match(firstPrompt ?? "", /Read the requested file before answering/);
  assert.match(firstPrompt ?? "", /<user-request>\nRead \/fixture\.txt/);
  assert.ok(
    requests[1].messages.some((message) =>
      message.content.some((part) => part instanceof vscode.LanguageModelToolResultPart),
    ),
    "The Deep Agents tool result should be mapped back into a VS Code user tool-result message",
  );
  assert.ok(
    requests[1].messages.some((message) =>
      message.content.some(
        (part) =>
          part instanceof vscode.LanguageModelTextPart &&
          part.value.includes("Read the requested file before answering."),
      ),
    ),
    "The Deep Agents system prompt should remain present after a tool result",
  );
  assert.deepEqual(events, ["toolCall", "toolResult", "text"]);
  assert.deepEqual([...seenToolResults], ["read-fixture"]);

  const replayEvents: string[] = [];
  const replayAdapter = new VsCodeChatModel({
    model: fakeModel,
    seenToolResults,
    onEvent: (event) => replayEvents.push(event.kind),
  });
  await replayAdapter.invoke([
    new HumanMessage("Read /fixture.txt"),
    new AIMessage({
      content: "",
      tool_calls: [{
        id: "read-fixture",
        name: "read_file",
        args: { file_path: "/fixture.txt" },
        type: "tool_call",
      }],
    }),
    new ToolMessage({
      content: "adapter integration works",
      tool_call_id: "read-fixture",
      name: "read_file",
    }),
  ]);
  assert.deepEqual(
    replayEvents,
    ["text"],
    "A new owner adapter must not re-emit a tool result already surfaced in this session.",
  );
  assert.equal(prompts.length, 2);
  assert.ok(
    prompts.every(
      ({ systemPrompt }) =>
        systemPrompt.includes("Read the requested file before answering."),
    ),
  );
  assert.ok(
    prompts.every(
      ({ systemPrompt }) =>
        !systemPrompt.includes("You are a Deep Agent"),
    ),
    "The disabled DeepAgents base prompt must not reach the model.",
  );
  assert.ok(
    prompts.every(({ userPrompt }) => userPrompt === "Read /fixture.txt"),
  );
  assert.ok(final && String(final.content).includes("adapter integration works"));

  const isolatedPrompts: Array<{
    systemPrompt: string;
    userPrompt: string;
  }> = [];
  const isolatedAdapter = adapter.fork({
    emitEvents: false,
    onPrompt: (snapshot) => isolatedPrompts.push(snapshot),
  });
  const eventCountBeforeIsolatedRun = events.length;
  await createDeepAgent({
    model: isolatedAdapter,
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    systemPrompt: configureDeepAgentSystemPrompt(
      "This is an isolated child model call.",
      false,
    ),
  }).invoke({
    messages: [{ role: "user", content: "Return silently." }],
  });
  assert.equal(
    events.length,
    eventCountBeforeIsolatedRun,
    "an isolated fork must not forward text or tool events to the owner adapter",
  );
  assert.equal(isolatedPrompts.length, 1);
  assert.match(
    isolatedPrompts[0].systemPrompt,
    /isolated child model call/,
    "an isolated fork should retain independent prompt observability",
  );

  const compactionEvents: string[] = [];
  const compactionPrompts: ModelPromptSnapshot[] = [];
  const compactionModel = {
    ...fakeModel,
    id: "compaction-fixture",
    async sendRequest(
      messages: vscode.LanguageModelChatMessage[],
    ) {
      const text = messages
        .flatMap((message) => message.content)
        .filter(
          (part): part is vscode.LanguageModelTextPart =>
            part instanceof vscode.LanguageModelTextPart,
        )
        .map((part) => part.value)
        .join("\n");
      return {
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart(
            text.includes("You are a conversation summarizer")
              ? "INTERNAL COMPACTION SUMMARY"
              : "Visible response after compaction.",
          );
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const visibleCompactionAdapter = new VsCodeChatModel({
    model: compactionModel,
    onEvent: (event) => {
      if (event.kind === "text") compactionEvents.push(event.text);
    },
    onPrompt: (snapshot) => compactionPrompts.push(snapshot),
  });
  const compactionBackend = new FilesystemBackend({
    rootDir: root,
    virtualMode: true,
  });
  await createDeepAgent({
    model: visibleCompactionAdapter,
    backend: compactionBackend,
    middleware: [
      createSummarizationMiddleware({
        model: visibleCompactionAdapter,
        backend: compactionBackend,
        trigger: { type: "messages", value: 2 },
        keep: { type: "messages", value: 1 },
      }),
    ],
  }).invoke({
    messages: [
      { role: "user", content: "Earlier context." },
      { role: "assistant", content: "Earlier response." },
      { role: "user", content: "Continue after compaction." },
    ],
  });
  assert.deepEqual(
    compactionEvents,
    ["Visible response after compaction."],
    "internal summary text must not be forwarded as conversation output",
  );
  const internalCompactionPrompt = compactionPrompts.find(
    ({ purpose }) => purpose === "compaction",
  );
  assert.ok(internalCompactionPrompt);
  assert.match(
    internalCompactionPrompt.userPrompt,
    /conversation summarizer/i,
    "compaction should remain observable through its separately labeled prompt",
  );

  console.log("Adapter integration test passed: vscode.lm tool call -> Deep Agents execution -> tool result -> final response");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
