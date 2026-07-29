import assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  collectRuntimeDiagnostics,
  renderRuntimeDiagnostics,
} from "../src/runtimeDiagnostics";

function main(): void {
  const registeredTool = {
    name: "mcp_fixture_read",
    description: "PRIVATE DESCRIPTION MUST NOT APPEAR",
    tags: ["mcp", "read-only"],
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "PRIVATE FIELD DESCRIPTION MUST NOT APPEAR",
          default: "PRIVATE DEFAULT MUST NOT APPEAR",
        },
      },
      required: ["key"],
    },
  };
  const snapshot = collectRuntimeDiagnostics({
    models: [
      {
        id: "copilot/test",
        name: "Test Model",
        vendor: "copilot",
        family: "test",
        version: "1",
        maxInputTokens: 16_000,
      } as vscode.LanguageModelChat,
    ],
    registeredTools: [registeredTool],
    extensions: [
      {
        id: "fixture.extension",
        packageJSON: {
          version: "1.2.3",
          contributes: {
            languageModelTools: [{ name: "mcp_fixture_read" }],
          },
        },
      } as vscode.Extension<unknown>,
    ],
    vscodeVersion: "1.105.0",
    mcpConfiguration: {
      filePaths: ["/PRIVATE/PATH/mcp.json"],
      servers: {
        fixture: {
          type: "stdio",
          command: "PRIVATE COMMAND MUST NOT APPEAR",
          env: { TOKEN: "PRIVATE TOKEN MUST NOT APPEAR" },
        },
      },
      sources: {
        fixture: {
          kind: "vscode",
          filePath: "/PRIVATE/PATH/mcp.json",
        },
      },
    },
    capturedAt: new Date("2026-07-29T20:00:00.000Z"),
  });

  assert.deepEqual(snapshot.safety, {
    containsModelPrompts: false,
    containsToolInputs: false,
    containsToolResults: false,
    containsMcpLaunchConfiguration: false,
  });
  assert.deepEqual(snapshot.models, [
    {
      id: "copilot/test",
      name: "Test Model",
      vendor: "copilot",
      family: "test",
      version: "1",
      maxInputTokens: 16_000,
    },
  ]);
  assert.deepEqual(snapshot.registeredTools[0]?.schema, {
    type: "object",
    required: ["key"],
    properties: [{ name: "key", type: "string", required: true }],
  });
  assert.deepEqual(snapshot.resolvedTools.mcp, [
    {
      canonicalName: "fixture/read",
      providerName: "mcp_fixture_read",
      serverName: "fixture",
    },
  ]);

  const rendered = renderRuntimeDiagnostics(snapshot);
  assert.match(rendered, /registration metadata only/);
  assert.match(rendered, /mcp_fixture_read/);
  assert.match(rendered, /copilot\/test/);
  for (const privateValue of [
    "PRIVATE DESCRIPTION",
    "PRIVATE FIELD DESCRIPTION",
    "PRIVATE DEFAULT",
    "PRIVATE COMMAND",
    "PRIVATE TOKEN",
    "/PRIVATE/PATH",
  ]) {
    assert.doesNotMatch(rendered, new RegExp(privateValue));
  }

  const unavailable = collectRuntimeDiagnostics({
    models: [],
    registeredTools: [
      {
        name: "orphan",
        description: "Orphan",
        tags: [],
        inputSchema: undefined,
      },
      {
        name: "orphan",
        description: "Duplicate orphan",
        tags: [],
        inputSchema: undefined,
      },
    ],
    extensions: [],
    vscodeVersion: "1.105.0",
  });
  const codes = unavailable.diagnostics.map((entry) => entry.code);
  assert.ok(codes.includes("models.runtime.provider-unavailable"));
  assert.ok(codes.includes("tools.runtime.duplicate-name"));
  assert.ok(codes.includes("tools.runtime.unattributed"));
  assert.equal(
    unavailable.diagnostics.filter(
      (entry) => entry.code === "tools.runtime.unattributed",
    ).length,
    1,
  );
  assert.match(
    unavailable.diagnostics.find(
      (entry) => entry.code === "tools.runtime.unattributed",
    )?.message ?? "",
    /^2 registered language-model tools/,
  );

  console.log(
    "Runtime diagnostics test passed: structured model/tool resolution and metadata-only redaction",
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
