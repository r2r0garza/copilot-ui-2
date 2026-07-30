import assert from "node:assert/strict";
import { renderProjectSkillsPrompt } from "../src/projectSkillsMiddleware";
import type { ProjectSkillDefinition } from "../src/projectCustomizations";

const workspaceRoot = "/workspace";
const skills: ProjectSkillDefinition[] = [
  {
    scopePath: "",
    directoryPath: `${workspaceRoot}/.github/skills/haiku`,
    filePath: `${workspaceRoot}/.github/skills/haiku/SKILL.md`,
    name: "haiku",
    description: "Write a concise seasonal haiku.",
    body: "Write three lines.",
    metadata: {},
  },
  {
    scopePath: "repo-1",
    directoryPath: `${workspaceRoot}/repo-1/.github/skills/review`,
    filePath: `${workspaceRoot}/repo-1/.github/skills/review/SKILL.md`,
    name: "review",
    description: "Review the nested repository.",
    body: "Review locally.",
    metadata: {},
  },
];

const prompt = renderProjectSkillsPrompt(skills, workspaceRoot);
assert.match(prompt, /haiku: Write a concise seasonal haiku/);
assert.match(prompt, /\/\.github\/skills\/haiku\/SKILL\.md/);
assert.match(prompt, /repo-1\/review: Review the nested repository/);
assert.match(
  prompt,
  /\/repo-1\/\.github\/skills\/review\/SKILL\.md/,
);
assert.match(prompt, /read its SKILL\.md with read_file/);
assert.match(prompt, /do not expand tool access or authorize file changes/i);
assert.equal(renderProjectSkillsPrompt([], workspaceRoot), "");

console.log(
  "Project skills middleware test passed: fresh skill metadata and safe progressive-disclosure instructions are rendered",
);
