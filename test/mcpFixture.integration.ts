import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { discoverProjectCustomizations } from "../src/projectCustomizations";

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const fixturePath = join(
    workspaceRoot,
    ".planning",
    "003-runtime-capabilities",
    "fixtures",
    "mcp-server.mjs",
  );
  const client = new Client({
    name: "bridgit-runtime-fixture-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath],
    cwd: workspaceRoot,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
      })),
      [
        {
          name: "read_fixture",
          description:
            "Read a deterministic value from the Bridgit runtime MCP fixture.",
          readOnlyHint: true,
          destructiveHint: false,
        },
      ],
    );

    const result = await client.callTool({
      name: "read_fixture",
      arguments: { key: "alpha" },
    });
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: "bridgit-runtime-fixture:alpha",
      },
    ]);

    const discovered =
      await discoverProjectCustomizations(workspaceRoot);
    assert.deepEqual(
      discovered.mcp?.servers["bridgit-runtime-fixture"],
      {
        type: "stdio",
        command: "${env:HOME}/.local/bin/node",
        args: [
          "${workspaceFolder}/.planning/003-runtime-capabilities/fixtures/mcp-server.mjs",
        ],
      },
    );
    assert.equal(
      discovered.mcp?.sources["bridgit-runtime-fixture"]?.kind,
      "vscode",
    );
  } finally {
    await client.close();
  }

  console.log(
    "MCP fixture integration passed: VS Code configuration discovery, stdio startup, tool listing, and deterministic invocation",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
