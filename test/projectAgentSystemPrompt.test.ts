import assert from "node:assert/strict";
import { resolveAgentToolPolicy } from "../src/agentToolPolicy";
import {
  renderProjectAgentSystemPrompt,
} from "../src/projectAgentSystemPrompt";

const workspaceRoot = "/workspace";

const readOnlyPrompt = renderProjectAgentSystemPrompt({
  agentInstructions: "Inspect the repository and report findings.",
  includeDeepAgentCorePrompt: false,
  policy: resolveAgentToolPolicy([]),
  subagents: [],
  skills: [],
  workspaceRoot,
  visibleToolNames: ["ls", "read_file", "glob", "grep", "write_todos"],
});

assert.match(readOnlyPrompt, /^Inspect the repository/);
assert.match(readOnlyPrompt, /## Filesystem Tools/);
assert.match(readOnlyPrompt, /- ls:/);
assert.match(readOnlyPrompt, /- read_file:/);
assert.match(
  readOnlyPrompt,
  /If fewer lines were returned, stop\./,
);
assert.match(readOnlyPrompt, /- glob:/);
assert.match(readOnlyPrompt, /- grep:/);
assert.match(readOnlyPrompt, /## Large Tool Results/);
assert.match(readOnlyPrompt, /## `write_todos`/);
assert.doesNotMatch(readOnlyPrompt, /write_file:/);
assert.doesNotMatch(readOnlyPrompt, /edit_file:/);
assert.doesNotMatch(readOnlyPrompt, /## `execute_command`/);
assert.doesNotMatch(readOnlyPrompt, /subagent spawner/);

const delegationPolicy = resolveAgentToolPolicy(["agent"]);
const delegationPrompt = renderProjectAgentSystemPrompt({
  agentInstructions: "Delegate fixture reads.",
  includeDeepAgentCorePrompt: true,
  policy: delegationPolicy,
  subagents: [
    {
      name: "delegation-reader",
      description: "Reads delegation fixtures.",
    },
    {
      name: "delegation-writer",
      description: "Edits delegation fixtures.",
    },
  ],
  skills: [],
  workspaceRoot,
  visibleToolNames: [
    "ls",
    "read_file",
    "glob",
    "grep",
    "write_todos",
    "task",
  ],
});

assert.match(delegationPrompt, /You are a deep agent/);
assert.match(delegationPrompt, /## `task` \(subagent spawner\)/);
assert.match(
  delegationPrompt,
  /Issue multiple independent `task` tool calls in the same model response/,
);
assert.match(
  delegationPrompt,
  /delegation-reader: Reads delegation fixtures/,
);
assert.match(
  delegationPrompt,
  /delegation-writer: Edits delegation fixtures/,
);
assert.doesNotMatch(delegationPrompt, /general-purpose/);

assert.match(
  readOnlyPrompt,
  /Use `grep` within `\/large_tool_results\/` for targeted facts/,
);

console.log(
  "Project agent system prompt test passed: prompt sections match resolved capabilities",
);
