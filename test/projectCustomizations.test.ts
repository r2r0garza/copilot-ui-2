import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverProjectCustomizations } from "../src/projectCustomizations";

async function main(): Promise<void> {
  await discoversValidProjectCustomizations();
  await preservesOmittedAndEmptyToolLists();
  await reportsInvalidCustomizationsWithoutFailingDiscovery();
  await handlesMissingGithubDirectory();
  await mergesMcpSourcesWithVsCodePrecedence();
  console.log(
    "Project customization tests passed: agents, skills, MCP, semantics, and diagnostics",
  );
}

async function discoversValidProjectCustomizations(): Promise<void> {
  const root = await createWorkspace();
  await writeProjectFile(
    root,
    ".github/agents/researcher.agent.md",
    [
      "---",
      "name: Researcher",
      "description: Researches a topic",
      "argument-hint: Describe the research question",
      "tools: [read, web]",
      "agents: reviewer",
      "user-invocable: false",
      "disable-model-invocation: true",
      "---",
      "Research carefully.",
    ].join("\n"),
  );
  await writeProjectFile(
    root,
    ".github/skills/citations/SKILL.md",
    [
      "---",
      "name: citations",
      "description: Produces accurate citations",
      "---",
      "Use primary sources.",
    ].join("\n"),
  );
  await writeProjectFile(
    root,
    ".github/mcp.json",
    JSON.stringify({
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp"],
        },
      },
    }),
  );

  const discovered = await discoverProjectCustomizations(root);
  assert.equal(discovered.agents.length, 1);
  assert.deepEqual(discovered.agents[0], {
    id: "researcher",
    filePath: join(root, ".github/agents/researcher.agent.md"),
    name: "Researcher",
    description: "Researches a topic",
    argumentHint: "Describe the research question",
    tools: ["read", "web"],
    agents: ["reviewer"],
    userInvocable: false,
    disableModelInvocation: true,
    body: "Research carefully.",
    metadata: {
      name: "Researcher",
      description: "Researches a topic",
      "argument-hint": "Describe the research question",
      tools: ["read", "web"],
      agents: "reviewer",
      "user-invocable": false,
      "disable-model-invocation": true,
    },
  });
  assert.equal(discovered.skills.length, 1);
  assert.equal(discovered.skills[0]?.name, "citations");
  assert.equal(discovered.skills[0]?.body, "Use primary sources.");
  assert.deepEqual(Object.keys(discovered.mcp?.servers ?? {}), ["playwright"]);
  assert.equal(discovered.mcp?.sources.playwright?.kind, "github");
  assert.deepEqual(discovered.diagnostics, []);
}

async function preservesOmittedAndEmptyToolLists(): Promise<void> {
  const root = await createWorkspace();
  await writeProjectFile(
    root,
    ".github/agents/all.agent.md",
    ["---", "name: All", "---", "All tools."].join("\n"),
  );
  await writeProjectFile(
    root,
    ".github/agents/none.agent.md",
    ["---", "name: None", "tools: []", "---", "No tools."].join("\n"),
  );
  await writeProjectFile(
    root,
    ".github/agents/aliases.agent.md",
    [
      "---",
      "name: Aliases",
      "tools: Read, Write, Bash",
      "---",
      "Use selected tools.",
    ].join("\n"),
  );

  const discovered = await discoverProjectCustomizations(root);
  assert.equal(discovered.agents.length, 3);
  assert.equal(
    discovered.agents.find((agent) => agent.id === "all")?.tools,
    undefined,
  );
  assert.deepEqual(
    discovered.agents.find((agent) => agent.id === "none")?.tools,
    [],
  );
  assert.deepEqual(
    discovered.agents.find((agent) => agent.id === "aliases")?.tools,
    ["Read", "Write", "Bash"],
  );
}

async function reportsInvalidCustomizationsWithoutFailingDiscovery(): Promise<void> {
  const root = await createWorkspace();
  await writeProjectFile(
    root,
    ".github/agents/valid.agent.md",
    ["---", "name: Valid", "---", "Works."].join("\n"),
  );
  await writeProjectFile(
    root,
    ".github/agents/duplicate.agent.md",
    ["---", "name: valid", "---", "Duplicate."].join("\n"),
  );
  await writeProjectFile(
    root,
    ".github/agents/broken.agent.md",
    ["---", "name: [broken", "---", "Broken."].join("\n"),
  );
  await writeProjectFile(
    root,
    ".github/agents/invalid-tools.agent.md",
    [
      "---",
      "name: Invalid Tools",
      "tools:",
      "  read: true",
      "---",
      "Must not receive all tools.",
    ].join("\n"),
  );
  await writeProjectFile(
    root,
    ".github/skills/missing-description/SKILL.md",
    ["---", "name: incomplete", "---", "Incomplete."].join("\n"),
  );
  await mkdir(join(root, ".github/skills/not-a-skill"), { recursive: true });
  await writeProjectFile(root, ".github/mcp.json", "{ invalid json");

  const discovered = await discoverProjectCustomizations(root);
  assert.equal(discovered.agents.length, 1);
  assert.equal(discovered.skills.length, 0);
  assert.equal(discovered.mcp, undefined);
  assert.deepEqual(
    new Set(discovered.diagnostics.map((diagnostic) => diagnostic.code)),
    new Set([
      "agent.duplicate-name",
      "frontmatter.invalid-field",
      "frontmatter.invalid-yaml",
      "skill.missing-description",
      "skill.missing-file",
      "mcp.invalid-json",
    ]),
  );
}

async function handlesMissingGithubDirectory(): Promise<void> {
  const root = await createWorkspace();
  const discovered = await discoverProjectCustomizations(root);
  assert.deepEqual(discovered.agents, []);
  assert.deepEqual(discovered.skills, []);
  assert.equal(discovered.mcp, undefined);
  assert.deepEqual(discovered.diagnostics, []);
}

async function mergesMcpSourcesWithVsCodePrecedence(): Promise<void> {
  const root = await createWorkspace();
  await writeProjectFile(
    root,
    ".github/mcp.json",
    JSON.stringify({
      mcpServers: {
        shared: {
          transport: "stdio",
          command: "github-command",
        },
        "github-only": {
          transport: "http",
          url: "https://example.com/github",
        },
      },
    }),
  );
  await writeProjectFile(
    root,
    ".vscode/mcp.json",
    JSON.stringify({
      inputs: [],
      servers: {
        shared: {
          type: "stdio",
          command: "vscode-command",
        },
        "vscode-only": {
          type: "http",
          url: "https://example.com/vscode",
        },
      },
    }),
  );

  const discovered = await discoverProjectCustomizations(root);
  assert.deepEqual(Object.keys(discovered.mcp?.servers ?? {}).sort(), [
    "github-only",
    "shared",
    "vscode-only",
  ]);
  assert.equal(
    discovered.mcp?.servers.shared?.command,
    "vscode-command",
  );
  assert.equal(discovered.mcp?.sources.shared?.kind, "vscode");
  assert.equal(discovered.mcp?.sources["github-only"]?.kind, "github");
  assert.equal(discovered.mcp?.sources["vscode-only"]?.kind, "vscode");
  assert.deepEqual(
    discovered.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      path: diagnostic.path,
    })),
    [
      {
        severity: "warning",
        code: "mcp.duplicate-server",
        path: ".vscode/mcp.json",
      },
    ],
  );
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "project-customizations-"));
}

async function writeProjectFile(
  root: string,
  projectRelativePath: string,
  contents: string,
): Promise<void> {
  const filePath = join(root, projectRelativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
