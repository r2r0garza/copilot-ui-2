import assert from "node:assert/strict";
import {
  resolveProjectAgentDelegation,
} from "../src/projectAgentDelegation";
import type {
  ProjectAgentDefinition,
  ProjectCustomizations,
} from "../src/projectCustomizations";

function agent(
  id: string,
  input: Partial<ProjectAgentDefinition> = {},
): ProjectAgentDefinition {
  return {
    id,
    filePath: `/.github/agents/${id}.agent.md`,
    name: id,
    userInvocable: true,
    disableModelInvocation: false,
    body: `You are ${id}.`,
    metadata: {},
    ...input,
  };
}

const hidden = agent("hidden", { userInvocable: false });
const disabled = agent("disabled", { disableModelInvocation: true });
const nested = agent("nested", { agents: ["leaf"] });
const leaf = agent("leaf");
const cyclic = agent("cyclic", { agents: ["parent"] });
const parent = agent("parent", {
  agents: ["HIDDEN", "disabled", "missing", "nested", "cyclic", "hidden"],
});
const customizations: Pick<ProjectCustomizations, "agents"> = {
  agents: [parent, hidden, disabled, nested, leaf, cyclic],
};

const result = resolveProjectAgentDelegation(parent, customizations);
assert.deepEqual(
  result.children.map((child) => child.id),
  ["hidden", "nested"],
  "hidden agents remain delegatable, while disabled, unknown, cyclic, and duplicate entries do not",
);
assert.deepEqual(
  result.diagnostics.map((diagnostic) => diagnostic.code),
  [
    "delegation.model-invocation-disabled",
    "delegation.unknown-agent",
    "delegation.depth-limited",
    "delegation.cycle",
  ],
);

assert.deepEqual(
  resolveProjectAgentDelegation(
    agent("none"),
    { agents: [agent("none"), leaf] },
  ),
  { children: [], diagnostics: [] },
  "an omitted agents list exposes no children",
);

console.log(
  "Project agent delegation test passed: allowlists, hidden children, disabled agents, cycles, and depth are bounded",
);
