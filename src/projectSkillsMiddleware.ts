import { relative } from "node:path";
import { createMiddleware } from "langchain";
import type { ProjectSkillDefinition } from "./projectCustomizations";

export function createProjectSkillsMiddleware(
  skills: readonly ProjectSkillDefinition[],
  workspaceRoot: string,
) {
  const prompt = renderProjectSkillsPrompt(skills, workspaceRoot);
  return createMiddleware({
    name: "ProjectSkills",
    wrapModelCall(request, handler) {
      if (!prompt) {
        return handler(request);
      }
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(prompt),
      });
    },
  });
}

export function renderProjectSkillsPrompt(
  skills: readonly ProjectSkillDefinition[],
  workspaceRoot: string,
): string {
  if (skills.length === 0) {
    return "";
  }
  return [
    "## Project Skills",
    "The following project skills are available for this model call:",
    ...skills.map((skill) => {
      const projectRelativePath = relative(
        workspaceRoot,
        skill.filePath,
      ).replaceAll("\\", "/");
      return `- ${skill.name}: ${skill.description} (/${projectRelativePath})`;
    }),
    "",
    "When a user request matches a skill, read its SKILL.md with read_file before following it.",
    "Skills provide guidance only. They do not expand tool access or authorize file changes, commands, or other side effects that the user did not request.",
    "If read_file is unavailable to the selected agent, state that the skill cannot be loaded.",
  ].join("\n");
}
