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
    scopePath: "",
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

const rootReviewer = agent("reviewer");
const rootChild = agent("root-child");
const localReviewer = agent("repo-1/reviewer", {
  scopePath: "repo-1",
});
const siblingReviewer = agent("repo-2/reviewer", {
  scopePath: "repo-2",
});
const scopedParent = agent("repo-1/parent", {
  scopePath: "repo-1",
  agents: [
    "reviewer",
    "repo-1/reviewer",
    "repo-2/reviewer",
    "root-child",
  ],
});
const scopedResult = resolveProjectAgentDelegation(scopedParent, {
  agents: [
    scopedParent,
    rootReviewer,
    rootChild,
    localReviewer,
    siblingReviewer,
  ],
});
assert.deepEqual(
  scopedResult.children.map((child) => child.id),
  ["repo-1/reviewer", "repo-2/reviewer", "root-child"],
  "unqualified references resolve locally first, qualified references cross scopes, and missing local definitions fall back to root",
);

const localCycleParent = agent("repo-1/cycle-parent", {
  scopePath: "repo-1",
  agents: ["cycle-child"],
});
const localCycleChild = agent("repo-1/cycle-child", {
  scopePath: "repo-1",
  agents: ["cycle-parent"],
});
assert.deepEqual(
  resolveProjectAgentDelegation(localCycleParent, {
    agents: [localCycleParent, localCycleChild],
  }).diagnostics.map((diagnostic) => diagnostic.code),
  ["delegation.cycle"],
  "cycle detection must resolve each nested agent's unqualified references within its own scope",
);

console.log(
  "Project agent delegation test passed: allowlists, scoped references, hidden children, disabled agents, cycles, and depth are bounded",
);
