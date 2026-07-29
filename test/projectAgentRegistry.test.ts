import assert from "node:assert/strict";
import {
  ProjectAgentRegistry,
} from "../src/projectAgentRegistry";
import type {
  ProjectAgentDefinition,
  ProjectCustomizations,
} from "../src/projectCustomizations";

function agent(
  id: string,
  name: string,
  userInvocable = true,
): ProjectAgentDefinition {
  return {
    id,
    filePath: `/.github/agents/${id}.agent.md`,
    name,
    userInvocable,
    disableModelInvocation: false,
    body: `You are ${name}.`,
    metadata: {},
  };
}

const hidden = agent("hidden", "Hidden", false);
const writer = agent("writer", "Technical Writer");
const coder = agent("coder", "Coder");
const customizations: ProjectCustomizations = {
  workspaceRoot: "/workspace",
  agents: [writer, hidden, coder],
  skills: [],
  diagnostics: [],
};

const registry = new ProjectAgentRegistry(customizations);
assert.equal(registry.get("writer"), writer);
assert.equal(registry.get("missing"), undefined);
assert.equal(registry.get(null), undefined);
assert.deepEqual(
  registry.listUserInvocable().map((item) => item.id),
  ["coder", "writer"],
);

console.log(
  "Project agent registry test passed: stable IDs resolve and hidden agents are not user-selectable",
);
