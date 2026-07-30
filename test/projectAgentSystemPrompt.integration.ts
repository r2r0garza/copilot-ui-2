import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeepAgent,
  createSubAgentMiddleware,
  FilesystemBackend,
} from "deepagents";
import * as vscode from "vscode";
import {
  createAgentToolPolicyMiddleware,
  resolveAgentToolPolicy,
} from "../src/agentToolPolicy";
import {
  createProjectAgentSystemPromptMiddleware,
} from "../src/projectAgentSystemPrompt";
import {
  resolveProjectAgentSkills,
  type ProjectSkillDefinition,
} from "../src/projectCustomizations";
import { VsCodeChatModel } from "../src/vscodeChatModel";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "project-agent-system-prompt-"),
  );
  const systemPrompts: string[] = [];
  const requestTools: string[][] = [];
  const fakeModel = {
    id: "fake-project-agent-system-prompt",
    name: "Fake Project Agent System Prompt",
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
      requestTools.push((options.tools ?? []).map((tool) => tool.name).sort());
      return {
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart("Hello.");
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const adapter = new VsCodeChatModel({
    model: fakeModel,
    onPrompt: ({ systemPrompt }) => systemPrompts.push(systemPrompt),
  });
  const policy = resolveAgentToolPolicy(["agent"]);
  const child = createDeepAgent({
    model: adapter,
    name: "delegation-reader",
    backend: new FilesystemBackend({
      rootDir: workspaceRoot,
      virtualMode: true,
    }),
  });
  const agent = createDeepAgent({
    model: adapter,
    backend: new FilesystemBackend({
      rootDir: workspaceRoot,
      virtualMode: true,
    }),
    middleware: [
      createSubAgentMiddleware({
        defaultModel: adapter,
        subagents: [
          {
            name: "delegation-reader",
            description: "Reads delegation fixtures.",
            runnable: child,
          },
        ],
        generalPurposeAgent: false,
        systemPrompt: null,
      }),
      createAgentToolPolicyMiddleware(policy),
      createProjectAgentSystemPromptMiddleware({
        agentInstructions: "Delegate fixture reads.",
        includeDeepAgentCorePrompt: false,
        policy,
        subagents: [
          {
            name: "delegation-reader",
            description: "Reads delegation fixtures.",
          },
        ],
        skills: [],
        workspaceRoot,
      }),
    ],
    systemPrompt: { prefix: "", base: null },
  });

  await agent.invoke({
    messages: [{ role: "user", content: "hey" }],
  });

  assert.deepEqual(requestTools[0], [
    "glob",
    "grep",
    "ls",
    "read_file",
    "task",
    "write_todos",
  ]);
  assert.equal(systemPrompts.length, 1);
  assert.match(systemPrompts[0], /^Delegate fixture reads/);
  assert.match(systemPrompts[0], /## `task` \(subagent spawner\)/);
  assert.match(systemPrompts[0], /delegation-reader/);
  assert.match(systemPrompts[0], /## Filesystem Tools/);
  assert.match(systemPrompts[0], /## `write_todos`/);
  assert.doesNotMatch(systemPrompts[0], /general-purpose/);
  assert.doesNotMatch(systemPrompts[0], /write_file:/);
  assert.doesNotMatch(systemPrompts[0], /edit_file:/);

  const scopedPrompts: string[] = [];
  let scopedTurn = 0;
  const scopedModel = {
    ...fakeModel,
    id: "fake-project-agent-scoped-skills",
    async sendRequest() {
      scopedTurn += 1;
      const turn = scopedTurn;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              "delegate-scoped-child",
              "task",
              {
                description: "Inspect the child skill inventory.",
                subagent_type: "scoped-child",
              },
            );
          } else if (turn === 2) {
            yield new vscode.LanguageModelTextPart("Child complete.");
          } else {
            yield new vscode.LanguageModelTextPart("Parent complete.");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
  const scopedAdapter = new VsCodeChatModel({
    model: scopedModel,
    onPrompt: ({ systemPrompt }) => scopedPrompts.push(systemPrompt),
  });
  const availableSkills = [
    skill(workspaceRoot, "parent-skill"),
    skill(workspaceRoot, "child-skill"),
  ];
  const childPolicy = resolveAgentToolPolicy([]);
  const scopedChild = createDeepAgent({
    model: scopedAdapter,
    name: "scoped-child",
    backend: new FilesystemBackend({
      rootDir: workspaceRoot,
      virtualMode: true,
    }),
    middleware: [
      createAgentToolPolicyMiddleware(childPolicy),
      createProjectAgentSystemPromptMiddleware({
        agentInstructions: "Child owns child-skill.",
        includeDeepAgentCorePrompt: false,
        policy: childPolicy,
        subagents: [],
        skills: resolveProjectAgentSkills(
          { skills: ["child-skill"] },
          availableSkills,
        ),
        workspaceRoot,
      }),
    ],
    systemPrompt: { prefix: "", base: null },
  });
  const parentPolicy = resolveAgentToolPolicy(["agent"]);
  const scopedParent = createDeepAgent({
    model: scopedAdapter,
    backend: new FilesystemBackend({
      rootDir: workspaceRoot,
      virtualMode: true,
    }),
    middleware: [
      createSubAgentMiddleware({
        defaultModel: scopedAdapter,
        subagents: [{
          name: "scoped-child",
          description: "Checks child-scoped skills.",
          runnable: scopedChild,
        }],
        generalPurposeAgent: false,
        systemPrompt: null,
      }),
      createAgentToolPolicyMiddleware(parentPolicy),
      createProjectAgentSystemPromptMiddleware({
        agentInstructions: "Parent owns parent-skill.",
        includeDeepAgentCorePrompt: false,
        policy: parentPolicy,
        subagents: [{
          name: "scoped-child",
          description: "Checks child-scoped skills.",
        }],
        skills: resolveProjectAgentSkills(
          { skills: ["parent-skill"] },
          availableSkills,
        ),
        workspaceRoot,
      }),
    ],
    systemPrompt: { prefix: "", base: null },
  });

  await scopedParent.invoke({
    messages: [{ role: "user", content: "Delegate the scoped check." }],
  });

  const parentPrompts = scopedPrompts.filter((prompt) =>
    prompt.startsWith("Parent owns parent-skill.")
  );
  const childPrompts = scopedPrompts.filter((prompt) =>
    prompt.startsWith("Child owns child-skill.")
  );
  assert.ok(parentPrompts.length >= 1);
  assert.ok(childPrompts.length >= 1);
  for (const prompt of parentPrompts) {
    assert.match(prompt, /- parent-skill:/);
    assert.doesNotMatch(prompt, /- child-skill:/);
  }
  for (const prompt of childPrompts) {
    assert.match(prompt, /- child-skill:/);
    assert.doesNotMatch(prompt, /- parent-skill:/);
  }

  console.log(
    "Project agent system prompt integration passed: final model prompt, tools, and owner/child skills share resolved capabilities",
  );
}

function skill(
  workspaceRoot: string,
  name: string,
): ProjectSkillDefinition {
  return {
    directoryPath: join(workspaceRoot, ".github", "skills", name),
    filePath: join(
      workspaceRoot,
      ".github",
      "skills",
      name,
      "SKILL.md",
    ),
    name,
    description: `Guidance for ${name}.`,
    body: `Follow ${name}.`,
    metadata: {},
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
