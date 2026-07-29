export type ComposerAction = "send" | "stop" | "steer";

export interface ComposerControlState {
  action: ComposerAction;
  disabled: boolean;
  icon: "→" | "■" | "↑";
  label: string;
}

/**
 * Resolve the single primary composer control.
 *
 * This function is deliberately dependency-free because its source is embedded
 * into the webview so click and keyboard behavior use the same tested contract.
 */
export function resolveComposerControlState(
  running: boolean,
  text: string,
  agentSelected: boolean,
): ComposerControlState {
  const hasText = text.trim().length > 0;
  if (running) {
    return hasText
      ? {
          action: "steer",
          disabled: false,
          icon: "↑",
          label: "Send steering message",
        }
      : {
          action: "stop",
          disabled: false,
          icon: "■",
          label: "Stop active run",
        };
  }
  return {
    action: "send",
    disabled: !hasText || !agentSelected,
    icon: "→",
    label: agentSelected
      ? "Send message"
      : "Select an agent before sending",
  };
}
