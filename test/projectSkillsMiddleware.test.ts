import assert from "node:assert/strict";
import { renderProjectSkillsPrompt } from "../src/projectSkillsMiddleware";
import type { ProjectSkillDefinition } from "../src/projectCustomizations";

const workspaceRoot = "/workspace";
const skills: ProjectSkillDefinition[] = [
  {
    directoryPath: `${workspaceRoot}/.github/skills/haiku`,
    filePath: `${workspaceRoot}/.github/skills/haiku/SKILL.md`,
    name: "haiku",
    description: "Write a concise seasonal haiku.",
    body: "Write three lines.",
    metadata: {},
  },
];

const prompt = renderProjectSkillsPrompt(skills, workspaceRoot);
assert.match(prompt, /haiku: Write a concise seasonal haiku/);
assert.match(prompt, /\/\.github\/skills\/haiku\/SKILL\.md/);
assert.match(prompt, /read its SKILL\.md with read_file/);
assert.match(prompt, /do not expand tool access or authorize file changes/i);
assert.equal(renderProjectSkillsPrompt([], workspaceRoot), "");

console.log(
  "Project skills middleware test passed: fresh skill metadata and safe progressive-disclosure instructions are rendered",
);
