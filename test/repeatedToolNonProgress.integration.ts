import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import { createRepeatedToolNonProgressMiddleware } from "../src/repeatedToolNonProgress";
import { VsCodeChatModel } from "../src/vscodeChatModel";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "repeated-tool-non-progress-"));
  const requests: Array<{
    messages: vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }> = [];

  try {
    await writeFile(join(root, "empty.json"), "[]\n");
    const fakeModel = {
      id: "fake-repeated-tool-non-progress",
      name: "Fake Repeated Tool Non-Progress",
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
                `empty-read-${turn}`,
                "read_file",
                { file_path: "/empty.json" },
              );
            } else {
              yield new vscode.LanguageModelTextPart(
                "The unchanged read produced no new information, so I stopped retrying it.",
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
        createRepeatedToolNonProgressMiddleware(3),
      ],
    });
    const result = await agent.invoke({
      messages: [{
        role: "user",
        content: "Keep reading the same empty fixture without changing inputs.",
      }],
    });

    assert.equal(requests.length, 4);
    assert.deepEqual(
      requests[3]?.options.tools,
      [],
      "the threshold must force a final model response with no tools",
    );
    assert.match(
      JSON.stringify(requests[3]?.messages),
      /identical result 3 times/,
    );
    assert.match(
      String(result.messages.at(-1)?.content),
      /no new information/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Repeated tool non-progress integration passed: three identical successful calls terminate with one final no-tools explanation",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
