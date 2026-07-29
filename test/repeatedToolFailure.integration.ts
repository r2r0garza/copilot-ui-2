import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import {
  createAgentToolPolicyMiddleware,
  resolveAgentToolPolicy,
} from "../src/agentToolPolicy";
import { createRepeatedToolFailureMiddleware } from "../src/repeatedToolFailure";
import { VsCodeChatModel } from "../src/vscodeChatModel";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "repeated-tool-failure-"));
  const requests: Array<{
    messages: vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }> = [];

  try {
    const fakeModel = {
      id: "fake-repeated-tool-failure",
      name: "Fake Repeated Tool Failure",
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
            if (turn <= 3) {
              yield new vscode.LanguageModelToolCallPart(
                `forbidden-write-${turn}`,
                "write_file",
                {
                  file_path: "/missing-capability.txt",
                  content: "not written",
                },
              );
            } else {
              yield new vscode.LanguageModelTextPart(
                "I cannot write the file because this agent does not have write access.",
              );
            }
          })(),
          text: (async function* () {})(),
        };
      },
    } as vscode.LanguageModelChat;

    const agent = createDeepAgent({
      model: new VsCodeChatModel({ model: fakeModel }),
      backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
      middleware: [
        createRepeatedToolFailureMiddleware(3),
        createAgentToolPolicyMiddleware(resolveAgentToolPolicy(["read"])),
      ],
    });
    const result = await agent.invoke({
      messages: [{ role: "user", content: "Write the fixture." }],
    });

    assert.equal(requests.length, 4);
    assert.deepEqual(
      requests[3]?.options.tools,
      [],
      "the threshold must force a final model response with no tools",
    );
    assert.match(
      JSON.stringify(requests[3]?.messages),
      /same error 3 times/,
    );
    assert.match(
      String(result.messages.at(-1)?.content),
      /does not have write access/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Repeated tool failure integration passed: policy failures terminate after three equivalent calls with one final no-tools explanation",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
