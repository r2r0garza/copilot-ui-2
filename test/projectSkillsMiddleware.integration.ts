import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import { configureDeepAgentSystemPrompt } from "../src/deepAgentSystemPrompt";
import type { ProjectSkillDefinition } from "../src/projectCustomizations";
import { createProjectSkillsMiddleware } from "../src/projectSkillsMiddleware";
import { VsCodeChatModel } from "../src/vscodeChatModel";

function skill(
  workspaceRoot: string,
  name: string,
): ProjectSkillDefinition {
  return {
    scopePath: "",
    directoryPath: join(workspaceRoot, ".github", "skills", name),
    filePath: join(
      workspaceRoot,
      ".github",
      "skills",
      name,
      "SKILL.md",
    ),
    name,
    description: `Use the ${name} workflow.`,
    body: `Follow ${name}.`,
    metadata: {},
  };
}

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "deepagents-dynamic-skills-"),
  );
  const checkpointer = new MemorySaver();
  const prompts: string[] = [];
  const model = {
    id: "fake-copilot",
    name: "Fake Copilot",
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
          yield new vscode.LanguageModelTextPart("ok");
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;

  const invoke = async (
    skills: ProjectSkillDefinition[],
    message: string,
  ): Promise<void> => {
    const adapter = new VsCodeChatModel({
      model,
      onPrompt: ({ systemPrompt }) => prompts.push(systemPrompt),
    });
    const agent = createDeepAgent({
      model: adapter,
      backend: new FilesystemBackend({
        rootDir: workspaceRoot,
        virtualMode: true,
      }),
      checkpointer,
      middleware: [
        createProjectSkillsMiddleware(skills, workspaceRoot),
      ],
      systemPrompt: configureDeepAgentSystemPrompt(
        "Follow the selected project agent.",
        false,
      ),
    });
    await agent.invoke(
      { messages: [{ role: "user", content: message }] },
      { configurable: { thread_id: "existing-chat" } },
    );
  };

  try {
    const alpha = skill(workspaceRoot, "alpha");
    const beta = skill(workspaceRoot, "beta");
    await invoke([alpha], "Use alpha.");
    await invoke([alpha, beta], "Use beta.");

    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /alpha: Use the alpha workflow/);
    assert.doesNotMatch(prompts[0], /beta: Use the beta workflow/);
    assert.match(prompts[1], /alpha: Use the alpha workflow/);
    assert.match(prompts[1], /beta: Use the beta workflow/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }

  console.log(
    "Project skills integration test passed: an existing checkpointed chat sees newly discovered skills on its next turn",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
