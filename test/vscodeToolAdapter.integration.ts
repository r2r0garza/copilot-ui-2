import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import * as vscode from "vscode";
import {
  createAgentToolPolicyMiddleware,
  resolveAgentToolPolicy,
} from "../src/agentToolPolicy";
import { VsCodeChatModel } from "../src/vscodeChatModel";
import { createVsCodeToolAdapter } from "../src/vscodeToolAdapter";

interface ModelRequest {
  messages: vscode.LanguageModelChatMessage[];
  options: vscode.LanguageModelChatRequestOptions;
}

async function main(): Promise<void> {
  const fixtureProvider = {
    name: "fixture_readOnly",
    description: "Read a value from the controlled fixture.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Fixture key to read." },
      },
      required: ["key"],
    },
    tags: ["fixture", "read-only"],
  };
  const mutableTools = vscode.lm
    .tools as vscode.LanguageModelToolInformation[];
  mutableTools.splice(0, mutableTools.length, fixtureProvider);

  const providerInvocations: Array<{
    name: string;
    input: object;
    token: vscode.CancellationToken | undefined;
  }> = [];
  vscode.lm.invokeTool = async (name, options, token) => {
    const invocation =
      options as vscode.LanguageModelToolInvocationOptions<object>;
    const fixtureInput = invocation.input as Record<string, unknown>;
    providerInvocations.push({
      name,
      input: invocation.input,
      token: token as vscode.CancellationToken | undefined,
    });
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `value:${String(fixtureInput.key)}`,
      ),
    ]);
  };

  const adapter = createVsCodeToolAdapter({
    canonicalName: "fixture/read",
    providerName: "fixture_readOnly",
  });
  assert.equal(adapter.name, "fixture_readOnly");
  assert.equal(adapter.description, fixtureProvider.description);
  assert.deepEqual(adapter.schema, fixtureProvider.inputSchema);
  assert.equal(adapter.metadata?.canonicalName, "fixture/read");
  assert.equal(adapter.metadata?.providerName, "fixture_readOnly");

  const requests: ModelRequest[] = [];
  const allowedModel = createFixtureModel(requests, "fixture_readOnly");
  const allowedPolicy = resolveAgentToolPolicy(["fixture/read"], {
    mcpServerNames: ["fixture"],
  });
  const allowedAgent = createDeepAgent({
    model: new VsCodeChatModel({ model: allowedModel }),
    tools: [adapter],
    backend: new FilesystemBackend({
      rootDir: process.cwd(),
      virtualMode: true,
    }),
    middleware: [
      createAgentToolPolicyMiddleware(
        allowedPolicy,
        new Map([["fixture_readOnly", "fixture/read"]]),
      ),
    ],
  });
  const allowedResult = await allowedAgent.invoke({
    messages: [{ role: "user", content: "Read fixture alpha." }],
  });
  const final = [...allowedResult.messages]
    .reverse()
    .find((message) => AIMessage.isInstance(message));

  assert.deepEqual(
    requests[0]?.options.tools?.map((candidate) => ({
      name: candidate.name,
      description: candidate.description,
      inputSchema: candidate.inputSchema,
    })),
    [
      {
        name: "fixture_readOnly",
        description: fixtureProvider.description,
        inputSchema: fixtureProvider.inputSchema,
      },
    ],
  );
  assert.deepEqual(providerInvocations.map(({ name, input }) => ({ name, input })), [
    {
      name: "fixture_readOnly",
      input: { key: "alpha" },
    },
  ]);
  assert.match(JSON.stringify(requests[1]?.messages), /value:alpha/);
  assert.ok(final && String(final.content).includes("Fixture complete"));

  const deniedRequests: ModelRequest[] = [];
  const deniedModel = createFixtureModel(
    deniedRequests,
    "fixture_readOnly",
  );
  const deniedAgent = createDeepAgent({
    model: new VsCodeChatModel({ model: deniedModel }),
    tools: [adapter],
    backend: new FilesystemBackend({
      rootDir: process.cwd(),
      virtualMode: true,
    }),
    middleware: [
      createAgentToolPolicyMiddleware(
        resolveAgentToolPolicy(undefined),
        new Map([["fixture_readOnly", "fixture/read"]]),
      ),
    ],
  });
  await deniedAgent.invoke({
    messages: [{ role: "user", content: "Force the fixture call." }],
  });
  assert.deepEqual(deniedRequests[0]?.options.tools, []);
  assert.equal(
    providerInvocations.length,
    1,
    "A forced forbidden call must be blocked before provider invocation.",
  );
  assert.match(
    JSON.stringify(deniedRequests[1]?.messages),
    /not allowed by this agent's tools policy/,
  );

  vscode.lm.invokeTool = async (_name, _options, token) =>
    new Promise((_resolve, reject) => {
      const cancellationToken = token as vscode.CancellationToken;
      cancellationToken.onCancellationRequested(() =>
        reject(new vscode.CancellationError()),
      );
    });
  const controller = new AbortController();
  const cancellation = adapter.invoke(
    { key: "cancel" },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(cancellation, /cancelled/i);

  console.log(
    "VS Code tool adapter integration passed: schema, visibility, invocation, ToolMessage content, cancellation, and forced-call blocking",
  );
}

function createFixtureModel(
  requests: ModelRequest[],
  toolName: string,
): vscode.LanguageModelChat {
  let turn = 0;
  return {
    id: `fixture-model-${crypto.randomUUID()}`,
    name: "Fixture model",
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
              { key: "alpha" },
            );
          } else {
            yield new vscode.LanguageModelTextPart("Fixture complete.");
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
