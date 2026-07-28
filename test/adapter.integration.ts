import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import { VsCodeChatModel } from "../src/vscodeChatModel";

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
  const adapter = new VsCodeChatModel({
    model: fakeModel,
    onEvent: (event) => events.push(event.kind),
  });
  const agent = createDeepAgent({
    model: adapter,
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    systemPrompt: "Read the requested file before answering.",
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
  assert.ok(
    requests[1].messages.some((message) =>
      message.content.some((part) => part instanceof vscode.LanguageModelToolResultPart),
    ),
    "The Deep Agents tool result should be mapped back into a VS Code user tool-result message",
  );
  assert.deepEqual(events, ["toolCall", "toolResult", "text"]);
  assert.ok(final && String(final.content).includes("adapter integration works"));

  console.log("Adapter integration test passed: vscode.lm tool call -> Deep Agents execution -> tool result -> final response");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
