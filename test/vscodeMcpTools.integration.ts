import assert from "node:assert/strict";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import {
  createAgentToolPolicyMiddleware,
  resolveAgentToolPolicy,
} from "../src/agentToolPolicy";
import type { ProjectMcpConfiguration } from "../src/projectCustomizations";
import { VsCodeChatModel } from "../src/vscodeChatModel";
import {
  createAllowedVscodeMcpTools,
  resolveVscodeMcpTools,
} from "../src/vscodeMcpTools";

interface ModelRequest {
  messages: vscode.LanguageModelChatMessage[];
  options: vscode.LanguageModelChatRequestOptions;
}

async function main(): Promise<void> {
  const configuration: ProjectMcpConfiguration = {
    filePaths: ["/fixture/.vscode/mcp.json"],
    servers: {
      playwright: {
        type: "stdio",
        command: "playwright-mcp",
      },
      invalid: {
        type: "stdio",
      },
      absent: {
        type: "http",
        url: "https://example.test/mcp",
      },
    },
    sources: {
      playwright: {
        kind: "vscode",
        filePath: "/fixture/.vscode/mcp.json",
      },
      invalid: {
        kind: "vscode",
        filePath: "/fixture/.vscode/mcp.json",
      },
      absent: {
        kind: "vscode",
        filePath: "/fixture/.vscode/mcp.json",
      },
    },
  };
  const providerTools = [
    {
      name: "mcp_playwright_browser_click",
      description: "Click an element.",
      inputSchema: {
        type: "object",
        properties: { element: { type: "string" } },
        required: ["element"],
      },
      tags: ["mcp"],
    },
    {
      name: "mcp_playwright_browser_close",
      description: "Close the browser.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      tags: ["mcp"],
    },
  ] satisfies vscode.LanguageModelToolInformation[];
  const mutableTools = vscode.lm
    .tools as vscode.LanguageModelToolInformation[];
  mutableTools.splice(0, mutableTools.length, ...providerTools);

  const resolved = resolveVscodeMcpTools(configuration);
  assert.deepEqual(
    resolved.tools.map(({ canonicalName, providerName }) => ({
      canonicalName,
      providerName,
    })),
    [
      {
        canonicalName: "playwright/browser_click",
        providerName: "mcp_playwright_browser_click",
      },
      {
        canonicalName: "playwright/browser_close",
        providerName: "mcp_playwright_browser_close",
      },
    ],
  );
  assert.deepEqual(
    resolved.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    [
      "mcp.runtime.invalid-server",
      "mcp.runtime.provider-unavailable",
    ],
  );

  const ambiguousConfiguration: ProjectMcpConfiguration = {
    filePaths: [],
    servers: {
      foo: { command: "foo" },
      foo_bar: { command: "foo-bar" },
    },
    sources: {
      foo: { kind: "vscode", filePath: "/fixture/mcp.json" },
      foo_bar: { kind: "vscode", filePath: "/fixture/mcp.json" },
    },
  };
  const ambiguous = resolveVscodeMcpTools(
    ambiguousConfiguration,
    [
      {
        name: "mcp_foo_bar_baz",
        description: "Ambiguous fixture.",
        inputSchema: { type: "object" },
        tags: ["mcp"],
      },
    ],
  );
  assert.deepEqual(ambiguous.tools, []);
  assert.ok(
    ambiguous.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "mcp.runtime.ambiguous-provider",
    ),
  );

  const truncated = resolveVscodeMcpTools(
    {
      filePaths: [],
      servers: {
        "bridgit-runtime-fixture": {
          type: "stdio",
          command: "node",
        },
      },
      sources: {
        "bridgit-runtime-fixture": {
          kind: "vscode",
          filePath: "/fixture/mcp.json",
        },
      },
    },
    [
      {
        name: "mcp_bridgit-runti_read_fixture",
        description: "Read fixture.",
        inputSchema: { type: "object" },
        tags: ["mcp"],
      },
    ],
  );
  assert.deepEqual(
    truncated.tools.map(({ canonicalName, providerName }) => ({
      canonicalName,
      providerName,
    })),
    [
      {
        canonicalName: "bridgit-runtime-fixture/read_fixture",
        providerName: "mcp_bridgit-runti_read_fixture",
      },
    ],
  );

  const prefixCollision = resolveVscodeMcpTools(
    {
      filePaths: [],
      servers: {
        "abcdefghijklm-one": { command: "one" },
        "abcdefghijklm-two": { command: "two" },
      },
      sources: {
        "abcdefghijklm-one": {
          kind: "vscode",
          filePath: "/fixture/mcp.json",
        },
        "abcdefghijklm-two": {
          kind: "vscode",
          filePath: "/fixture/mcp.json",
        },
      },
    },
    [
      {
        name: "mcp_abcdefghijklm_read",
        description: "Collision fixture.",
        inputSchema: { type: "object" },
        tags: ["mcp"],
      },
    ],
  );
  assert.deepEqual(prefixCollision.tools, []);
  assert.ok(
    prefixCollision.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "mcp.runtime.ambiguous-provider" &&
        diagnostic.message.includes("share the same"),
    ),
  );

  const providerInvocations: string[] = [];
  vscode.lm.invokeTool = async (name) => {
    providerInvocations.push(name);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart("clicked"),
    ]);
  };
  const allowedPolicy = resolveAgentToolPolicy(
    ["playwright/browser_click"],
    { mcpServerNames: Object.keys(configuration.servers) },
  );
  const adapted = createAllowedVscodeMcpTools(
    configuration,
    allowedPolicy,
  );
  assert.deepEqual(
    adapted.tools.map((tool) => tool.name),
    ["mcp_playwright_browser_click"],
  );
  assert.deepEqual(
    [...adapted.modelNameAliases],
    [
      [
        "mcp_playwright_browser_click",
        "playwright/browser_click",
      ],
    ],
  );

  const allowedRequests: ModelRequest[] = [];
  const allowedAgent = createDeepAgent({
    model: new VsCodeChatModel({
      model: createFixtureModel(
        allowedRequests,
        "mcp_playwright_browser_click",
      ),
    }),
    tools: adapted.tools,
    backend: new FilesystemBackend({
      rootDir: process.cwd(),
      virtualMode: true,
    }),
    middleware: [
      createAgentToolPolicyMiddleware(
        allowedPolicy,
        adapted.modelNameAliases,
      ),
    ],
  });
  await allowedAgent.invoke({
    messages: [{ role: "user", content: "Click the fixture." }],
  });
  assert.deepEqual(providerInvocations, [
    "mcp_playwright_browser_click",
  ]);
  assert.deepEqual(
    allowedRequests[0]?.options.tools?.map((tool) => tool.name),
    ["mcp_playwright_browser_click"],
  );
  assert.match(
    JSON.stringify(allowedRequests[1]?.messages),
    /clicked/,
  );

  const deniedRequests: ModelRequest[] = [];
  const deniedAgent = createDeepAgent({
    model: new VsCodeChatModel({
      model: createFixtureModel(
        deniedRequests,
        "mcp_playwright_browser_close",
      ),
    }),
    tools: adapted.tools,
    backend: new FilesystemBackend({
      rootDir: process.cwd(),
      virtualMode: true,
    }),
    middleware: [
      createAgentToolPolicyMiddleware(
        allowedPolicy,
        adapted.modelNameAliases,
      ),
    ],
  });
  await deniedAgent.invoke({
    messages: [{ role: "user", content: "Force close." }],
  });
  assert.deepEqual(providerInvocations, [
    "mcp_playwright_browser_click",
  ]);
  assert.match(
    JSON.stringify(deniedRequests[1]?.messages),
    /not allowed by this agent's tools policy/,
  );

  console.log(
    "VS Code MCP integration passed: exact prefix resolution, invalid isolation, allowlisted invocation, and forced-call blocking",
  );
}

function createFixtureModel(
  requests: ModelRequest[],
  toolName: string,
): vscode.LanguageModelChat {
  let turn = 0;
  return {
    id: `mcp-fixture-${crypto.randomUUID()}`,
    name: "MCP fixture model",
    vendor: "copilot",
    family: "fixture",
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
      turn += 1;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              crypto.randomUUID(),
              toolName,
              { element: "fixture button" },
            );
          } else {
            yield new vscode.LanguageModelTextPart("MCP complete.");
          }
        })(),
        text: (async function* () {})(),
      };
    },
  } as vscode.LanguageModelChat;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
