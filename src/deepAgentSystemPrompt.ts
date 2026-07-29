export type DeepAgentSystemPrompt =
  | string
  | {
      prefix: string;
      base: null;
    };

export function configureDeepAgentSystemPrompt(
  agentInstructions: string,
  includeDefaultPrompt: boolean,
): DeepAgentSystemPrompt {
  return includeDefaultPrompt
    ? agentInstructions
    : {
        prefix: agentInstructions,
        base: null,
      };
}
