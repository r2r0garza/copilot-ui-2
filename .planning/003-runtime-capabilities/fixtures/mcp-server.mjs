import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "bridgit-runtime-fixture",
  version: "1.0.0",
});

server.registerTool(
  "read_fixture",
  {
    title: "Read Bridgit Runtime Fixture",
    description:
      "Read a deterministic value from the Bridgit runtime MCP fixture.",
    inputSchema: {
      key: z.string().min(1).describe("Fixture key to echo in the result."),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ key }) => ({
    content: [
      {
        type: "text",
        text: `bridgit-runtime-fixture:${key}`,
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
