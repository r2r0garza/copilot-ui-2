import assert from "node:assert/strict";
import {
  BASELINE_AGENT_TOOLS,
  renderAgentToolCapabilityPrompt,
  renderAgentToolPolicyBlock,
  resolveAgentToolPolicy,
} from "../src/agentToolPolicy";

function main(): void {
  const baseline = [...BASELINE_AGENT_TOOLS].sort();
  const omitted = resolveAgentToolPolicy(undefined);
  assert.equal(omitted.mode, "none");
  assert.deepEqual(omitted.resolvedTools, baseline);
  assert.equal(omitted.allows("read_file"), true);
  assert.equal(omitted.allows("write_todos"), true);

  const empty = resolveAgentToolPolicy([]);
  assert.equal(empty.mode, "none");
  assert.deepEqual(empty.resolvedTools, baseline);

  const wildcard = resolveAgentToolPolicy(["*"]);
  assert.equal(wildcard.mode, "all");
  assert.deepEqual(wildcard.resolvedTools, ["*"]);
  assert.equal(wildcard.allows("future_bridgit_tool"), true);

  const aliases = resolveAgentToolPolicy([
    "Read",
    "search",
    "Write",
    "Bash",
    "agent",
    "todo",
    "vscode",
  ]);
  assert.deepEqual(aliases.resolvedTools, [
    "edit_file",
    "execute_command",
    "glob",
    "grep",
    "ls",
    "read_file",
    "task",
    "write_file",
    "write_todos",
  ]);
  assert.deepEqual(aliases.diagnostics, []);
  assert.equal(aliases.allows("vscode/runCommand"), false);

  const granular = resolveAgentToolPolicy([
    "read/readFile",
    "search/listDirectory",
    "search/fileSearch",
    "search/textSearch",
    "edit/createFile",
    "edit/editFiles",
    "execute/runInTerminal",
    "agent/runSubagent",
    "web",
    "browser/screenshot",
  ]);
  assert.deepEqual(granular.resolvedTools, [
    "browser/screenshot",
    "edit_file",
    "execute_command",
    "glob",
    "grep",
    "ls",
    "read_file",
    "task",
    "web/fetch",
    "write_file",
    "write_todos",
  ]);

  const mcp = resolveAgentToolPolicy(
    ["playwright-mcp/*", "github/create_issue"],
    { mcpServerNames: ["playwright-mcp", "GitHub"] },
  );
  assert.deepEqual(mcp.resolvedTools, [
    "GitHub/create_issue",
    "glob",
    "grep",
    "ls",
    "playwright-mcp/*",
    "read_file",
    "write_todos",
  ]);
  assert.equal(mcp.allows("playwright-mcp/browser_click"), true);
  assert.equal(mcp.allows("GitHub/create_issue"), true);
  assert.equal(mcp.allows("GitHub/delete_issue"), false);

  const unknown = resolveAgentToolPolicy(
    ["missing-server/*", "not-a-tool"],
    { mcpServerNames: ["configured-server"] },
  );
  assert.deepEqual(
    unknown.diagnostics.map((diagnostic) => diagnostic.code),
    ["tools.unknown-mcp-server", "tools.unknown"],
  );
  assert.deepEqual(unknown.resolvedTools, baseline);

  const capabilityPrompt = renderAgentToolCapabilityPrompt(
    granular,
    ["read_file", "web/fetch"],
  );
  assert.match(
    capabilityPrompt,
    /Tools exposed for this model call: read_file, web\/fetch/,
  );
  assert.match(capabilityPrompt, /currently unavailable:.*write_file/);
  assert.match(capabilityPrompt, /inventory is authoritative/);

  const noToolsPrompt = renderAgentToolCapabilityPrompt(omitted, []);
  assert.match(noToolsPrompt, /Tools exposed for this model call: none/);

  const policyBlock = renderAgentToolPolicyBlock("write_file", omitted);
  assert.match(policyBlock, /was not executed/);
  assert.match(
    policyBlock,
    /Configured capabilities for this agent: glob, grep, ls, read_file, write_todos/,
  );
  assert.match(policyBlock, /Do not retry/);

  console.log(
    "Agent tool policy test passed: baseline tools, aliases, granular tools, MCP selectors, capability guidance, and diagnostics",
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
