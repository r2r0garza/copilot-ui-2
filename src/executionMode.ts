export const DEFAULT_EXECUTION_MODE = "default";

export type ExecutionMode = typeof DEFAULT_EXECUTION_MODE | "auto";

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === DEFAULT_EXECUTION_MODE || value === "auto";
}

export function shouldAutoApprove(mode: ExecutionMode): boolean {
  return mode === "auto";
}
