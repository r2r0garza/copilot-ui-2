import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import {
  createAgentToolPolicyMiddleware,
  resolveAgentToolPolicy,
} from "../src/agentToolPolicy";
import { VsCodeChatModel } from "../src/vscodeChatModel";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-tool-policy-"));
  const deniedPath = join(root, "denied.txt");
  const requests: Array<{
    messages: vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }> = [];

  const fakeModel = {
    id: "fake-tool-policy",
    name: "Fake Tool Policy",
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
              "forbidden-write",
              "write_file",
              {
                file_path: "/denied.txt",
                content: "must not be written",
              },
            );
          } else {
            yield new vscode.LanguageModelTextPart(
              "The write was blocked by policy.",
            );
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;

  const policy = resolveAgentToolPolicy(["read"]);
  const agent = createDeepAgent({
    model: new VsCodeChatModel({ model: fakeModel }),
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    middleware: [createAgentToolPolicyMiddleware(policy)],
  });
  await agent.invoke({
    messages: [{ role: "user", content: "Try to write denied.txt" }],
  });

  assert.deepEqual(
    requests[0]?.options.tools?.map((tool) => tool.name).sort(),
    ["ls", "read_file"],
    "Only the resolved read tools should be visible to the model.",
  );
  const secondRequestText = JSON.stringify(requests[1]?.messages ?? []);
  assert.match(secondRequestText, /not allowed by this agent's tools policy/);
  await assert.rejects(readFile(deniedPath, "utf8"), { code: "ENOENT" });

  const noToolsRequests: vscode.LanguageModelChatRequestOptions[] = [];
  const noToolsModel = {
    ...fakeModel,
    id: "fake-no-tools-policy",
    async sendRequest(
      _messages: vscode.LanguageModelChatMessage[],
      options: vscode.LanguageModelChatRequestOptions = {},
    ) {
      noToolsRequests.push(options);
      return {
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart("No tools available.");
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const noToolsAgent = createDeepAgent({
    model: new VsCodeChatModel({ model: noToolsModel }),
    backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    middleware: [
      createAgentToolPolicyMiddleware(resolveAgentToolPolicy(undefined)),
    ],
  });
  await noToolsAgent.invoke({
    messages: [{ role: "user", content: "Answer without tools" }],
  });
  assert.deepEqual(noToolsRequests[0]?.tools, []);

  console.log(
    "Agent tool policy integration passed: model filtering and fail-closed invocation guard",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
