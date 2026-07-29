import assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  LanguageModelToolInvocationError,
  collectRegisteredLanguageModelTools,
  invokeRegisteredLanguageModelTool,
  renderRegisteredLanguageModelToolInventory,
} from "../src/vscodeLanguageModelTools";

async function main(): Promise<void> {
  const fixtureTool = {
    name: "fixture_readOnly",
    description: "Reads controlled fixture data.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    tags: ["fixture", "read-only"],
  };
  const inventory = collectRegisteredLanguageModelTools(
    [
      fixtureTool,
      {
        name: "unattributed_tool",
        description: "Has no matching contribution.",
        inputSchema: undefined,
        tags: [],
      },
    ],
    [
      {
        id: "example.fixture",
        packageJSON: {
          version: "2.4.0",
          contributes: {
            languageModelTools: [{ name: "fixture_readOnly" }],
          },
        },
      } as vscode.Extension<unknown>,
    ],
    "1.105.0",
    new Date("2026-07-29T12:00:00.000Z"),
  );
  assert.equal(inventory.tools[0]?.name, "fixture_readOnly");
  assert.deepEqual(inventory.tools[0]?.contributingExtensions, [
    "example.fixture@2.4.0",
  ]);
  assert.equal(inventory.tools[1]?.name, "unattributed_tool");
  assert.deepEqual(inventory.tools[1]?.contributingExtensions, []);
  assert.throws(
    () => {
      (inventory.tools as unknown[]).push({});
    },
    TypeError,
  );

  const rendered = renderRegisteredLanguageModelToolInventory(inventory);
  assert.match(rendered, /no tools were invoked/i);
  assert.match(rendered, /fixture_readOnly/);
  assert.match(rendered, /example\.fixture@2\.4\.0/);
  assert.match(rendered, /Unattributed registered tools \(1\)/);
  assert.match(rendered, /do not infer one from the name/);

  const mutableTools = vscode.lm
    .tools as vscode.LanguageModelToolInformation[];
  mutableTools.splice(0, mutableTools.length, fixtureTool);
  let invocation:
    | { name: string; options: vscode.LanguageModelToolInvocationOptions<object> }
    | undefined;
  vscode.lm.invokeTool = async (name, options) => {
    invocation = {
      name,
      options: options as vscode.LanguageModelToolInvocationOptions<object>,
    };
    return new vscode.LanguageModelToolResult(
      [
        new vscode.LanguageModelTextPart("fixture result"),
        new vscode.LanguageModelPromptTsxPart({ node: "fixture" }),
        { futurePart: true },
      ] as Array<
        vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart
      >,
    );
  };
  const result = await invokeRegisteredLanguageModelTool(
    "fixture_readOnly",
    { key: "alpha" },
  );
  assert.deepEqual(invocation, {
    name: "fixture_readOnly",
    options: {
      input: { key: "alpha" },
      toolInvocationToken: undefined,
    },
  });
  assert.deepEqual(result, [
    { type: "text", text: "fixture result" },
    { type: "prompt-tsx", value: { node: "fixture" } },
    { type: "unknown", value: { futurePart: true } },
  ]);

  await assert.rejects(
    invokeRegisteredLanguageModelTool("missing_tool", {}),
    (error) =>
      error instanceof LanguageModelToolInvocationError &&
      error.code === "unavailable",
  );

  vscode.lm.invokeTool = async () => {
    const error = new Error("Consent denied") as Error & { code: string };
    error.code = "NoPermissions";
    throw error;
  };
  await assert.rejects(
    invokeRegisteredLanguageModelTool("fixture_readOnly", {}),
    (error) =>
      error instanceof LanguageModelToolInvocationError &&
      error.code === "permission-denied",
  );

  const controller = new AbortController();
  vscode.lm.invokeTool = async (_name, _options, token) =>
    new Promise((_resolve, reject) => {
      const cancellationToken = token as vscode.CancellationToken;
      cancellationToken.onCancellationRequested(() =>
        reject(new vscode.CancellationError()),
      );
      controller.abort();
    });
  await assert.rejects(
    invokeRegisteredLanguageModelTool(
      "fixture_readOnly",
      { key: "cancel" },
      controller.signal,
    ),
    (error) =>
      error instanceof LanguageModelToolInvocationError &&
      error.code === "cancelled",
  );

  vscode.lm.invokeTool = async () => {
    mutableTools.splice(0, mutableTools.length);
    throw new Error("Provider disappeared");
  };
  await assert.rejects(
    invokeRegisteredLanguageModelTool("fixture_readOnly", {}),
    (error) =>
      error instanceof LanguageModelToolInvocationError &&
      error.code === "unavailable",
  );

  console.log(
    "VS Code registered-tool tests passed: inventory, attribution, invocation, normalization, cancellation, and failure classification",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
