import assert from "node:assert/strict";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import {
  createAgentToolPolicyMiddleware,
  resolveAgentToolPolicy,
} from "../src/agentToolPolicy";
import { VsCodeChatModel } from "../src/vscodeChatModel";
import {
  createAllowedVscodeWebBrowserTools,
  resolveVscodeWebBrowserTools,
} from "../src/vscodeWebBrowserTools";

interface ModelRequest {
  messages: vscode.LanguageModelChatMessage[];
  options: vscode.LanguageModelChatRequestOptions;
}

const browserSchemas: Record<string, object> = {
  open_browser_page: objectSchema({
    url: { type: "string" },
    forceNew: { type: "boolean" },
  }),
  read_page: pageSchema(),
  navigate_page: pageSchema({
    type: { type: "string" },
    url: { type: "string" },
  }),
  click_element: pageSchema(
    {
      element: { type: "string" },
      ref: { type: "string" },
      selector: { type: "string" },
    },
    ["element"],
  ),
  type_in_page: pageSchema({
    text: { type: "string" },
    key: { type: "string" },
  }),
  hover_element: pageSchema(
    {
      element: { type: "string" },
      ref: { type: "string" },
      selector: { type: "string" },
    },
    ["element"],
  ),
  drag_element: pageSchema(
    {
      fromElement: { type: "string" },
      toElement: { type: "string" },
    },
    ["fromElement", "toElement"],
  ),
  handle_dialog: pageSchema({
    acceptModal: { type: "boolean" },
    promptText: { type: "string" },
    selectFiles: { type: "array", items: { type: "string" } },
  }),
  screenshot_page: pageSchema(),
  run_playwright_code: pageSchema({
    code: { type: "string" },
    deferredResultId: { type: "string" },
  }),
};

async function main(): Promise<void> {
  const registered = [
    {
      name: "copilot_fetchWebPage",
      description: "Provider fetch description.",
      tags: [],
      inputSchema: objectSchema(
        {
          urls: { type: "array", items: { type: "string" } },
          query: { type: "string" },
        },
        ["urls", "query"],
      ),
    },
    ...Object.entries(browserSchemas).map(([name, inputSchema]) => ({
      name,
      description: `Provider description for ${name}.`,
      tags: [],
      inputSchema,
    })),
  ] satisfies vscode.LanguageModelToolInformation[];
  const copilotExtension = {
    id: "GitHub.copilot-chat",
    packageJSON: {
      contributes: {
        languageModelTools: [{ name: "copilot_fetchWebPage" }],
      },
    },
  } as vscode.Extension<unknown>;

  const resolved = resolveVscodeWebBrowserTools(registered, [
    copilotExtension,
  ]);
  assert.deepEqual(
    resolved.tools.map(({ canonicalName, providerName }) => ({
      canonicalName,
      providerName,
    })),
    [
      { canonicalName: "browser/click", providerName: "click_element" },
      { canonicalName: "browser/dialog", providerName: "handle_dialog" },
      { canonicalName: "browser/drag", providerName: "drag_element" },
      { canonicalName: "browser/hover", providerName: "hover_element" },
      { canonicalName: "browser/navigate", providerName: "navigate_page" },
      { canonicalName: "browser/open", providerName: "open_browser_page" },
      { canonicalName: "browser/read", providerName: "read_page" },
      {
        canonicalName: "browser/run-code",
        providerName: "run_playwright_code",
      },
      {
        canonicalName: "browser/screenshot",
        providerName: "screenshot_page",
      },
      { canonicalName: "browser/type", providerName: "type_in_page" },
      { canonicalName: "web/fetch", providerName: "copilot_fetchWebPage" },
    ],
  );
  assert.deepEqual(
    resolved.diagnostics.map((diagnostic) => diagnostic.code),
    ["web.runtime.search-unavailable"],
  );

  const missingBrowser = resolveVscodeWebBrowserTools(
    registered.filter((tool) => tool.name !== "read_page"),
    [copilotExtension],
  );
  assert.equal(
    missingBrowser.tools.some((tool) => tool.kind === "browser"),
    false,
  );
  assert.ok(
    missingBrowser.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "browser.runtime.provider-unavailable" &&
        diagnostic.message.includes("read_page"),
    ),
  );

  const incompatibleBrowser = resolveVscodeWebBrowserTools(
    registered.map((tool) =>
      tool.name === "click_element"
        ? { ...tool, inputSchema: pageSchema() }
        : tool,
    ),
    [copilotExtension],
  );
  assert.equal(
    incompatibleBrowser.tools.some((tool) => tool.kind === "browser"),
    false,
  );
  assert.ok(
    incompatibleBrowser.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "browser.runtime.incompatible-provider",
    ),
  );

  const unattributedWeb = resolveVscodeWebBrowserTools(registered, []);
  assert.equal(
    unattributedWeb.tools.some(
      (tool) => tool.canonicalName === "web/fetch",
    ),
    false,
  );
  assert.ok(
    unattributedWeb.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "web.runtime.incompatible-provider",
    ),
  );

  const mutableTools = vscode.lm
    .tools as vscode.LanguageModelToolInformation[];
  mutableTools.splice(0, mutableTools.length, ...registered);
  const mutableExtensions = vscode.extensions.all as unknown[];
  mutableExtensions.splice(0, mutableExtensions.length, copilotExtension);

  const providerInvocations: string[] = [];
  vscode.lm.invokeTool = async (name) => {
    providerInvocations.push(name);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        name === "copilot_fetchWebPage"
          ? "explicit-url-content"
          : "interactive-browser-result",
      ),
    ]);
  };

  const webPolicy = resolveAgentToolPolicy(["web/fetch"]);
  const webTools = createAllowedVscodeWebBrowserTools(webPolicy);
  assert.deepEqual(
    webTools.tools.map((tool) => tool.name),
    ["copilot_fetchWebPage"],
  );
  assert.deepEqual(webTools.approvalProviderNames, []);
  assert.match(
    webTools.tools[0].description,
    /not web search/i,
  );
  assert.match(
    webTools.tools[0].description,
    /must not be used.*interactive form/i,
  );

  const browserPolicy = resolveAgentToolPolicy([
    "browser/open",
    "browser/read",
    "browser/click",
  ]);
  const browserTools = createAllowedVscodeWebBrowserTools(browserPolicy);
  assert.deepEqual(
    browserTools.tools.map((tool) => tool.name).sort(),
    ["click_element", "open_browser_page", "read_page"],
  );
  assert.deepEqual(browserTools.approvalProviderNames, ["click_element"]);
  assert.match(
    browserTools.tools.find((tool) => tool.name === "open_browser_page")
      ?.description ?? "",
    /interactive browser workflow/i,
  );

  const webRequests: ModelRequest[] = [];
  const webAgent = createDeepAgent({
    model: new VsCodeChatModel({
      model: createFixtureModel(
        webRequests,
        "copilot_fetchWebPage",
        { urls: ["https://example.test"], query: "heading" },
      ),
    }),
    tools: webTools.tools,
    backend: new FilesystemBackend({
      rootDir: process.cwd(),
      virtualMode: true,
    }),
    middleware: [
      createAgentToolPolicyMiddleware(
        webPolicy,
        webTools.modelNameAliases,
      ),
    ],
  });
  await webAgent.invoke({
    messages: [{ role: "user", content: "Fetch the known URL." }],
  });
  assert.deepEqual(providerInvocations, ["copilot_fetchWebPage"]);
  assert.deepEqual(
    webRequests[0]?.options.tools?.map((tool) => tool.name).sort(),
    [
      "copilot_fetchWebPage",
      "glob",
      "grep",
      "ls",
      "read_file",
      "write_todos",
    ],
  );

  const forcedRequests: ModelRequest[] = [];
  const forcedAgent = createDeepAgent({
    model: new VsCodeChatModel({
      model: createFixtureModel(
        forcedRequests,
        "click_element",
        { pageId: "page-1", element: "Submit" },
      ),
    }),
    tools: browserTools.tools,
    backend: new FilesystemBackend({
      rootDir: process.cwd(),
      virtualMode: true,
    }),
    middleware: [
      createAgentToolPolicyMiddleware(
        resolveAgentToolPolicy(["browser/read"]),
        browserTools.modelNameAliases,
      ),
    ],
  });
  await forcedAgent.invoke({
    messages: [{ role: "user", content: "Force a forbidden click." }],
  });
  assert.deepEqual(providerInvocations, ["copilot_fetchWebPage"]);
  assert.match(
    JSON.stringify(forcedRequests[1]?.messages ?? []),
    /browser\/click.*not allowed/i,
  );

  console.log(
    "VS Code web/browser integration passed: strict resolution, intent routing, provider invocation, approval classification, and forced-call blocking",
  );
}

function objectSchema(
  properties: Record<string, object>,
  required: string[] = [],
): object {
  return { type: "object", properties, required };
}

function pageSchema(
  properties: Record<string, object> = {},
  extraRequired: string[] = [],
): object {
  return objectSchema(
    {
      pageId: { type: "string" },
      ...properties,
    },
    ["pageId", ...extraRequired],
  );
}

function createFixtureModel(
  requests: ModelRequest[],
  toolName: string,
  input: object,
): vscode.LanguageModelChat {
  return {
    id: `fixture-${toolName}`,
    name: `Fixture ${toolName}`,
    vendor: "copilot",
    family: "fixture",
    version: "1",
    maxInputTokens: 32_000,
    async countTokens() {
      return 1;
    },
    async sendRequest(messages, options = {}) {
      requests.push({ messages: [...messages], options });
      const turn = requests.length;
      return {
        stream: (async function* () {
          if (turn === 1) {
            yield new vscode.LanguageModelToolCallPart(
              `${toolName}-call`,
              toolName,
              input,
            );
          } else {
            yield new vscode.LanguageModelTextPart("Finished.");
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
