import {
  Command,
  type CommandInstance,
  type StateSnapshot,
} from "@langchain/langgraph";

export type DurableContinuationErrorCode =
  | "missing_checkpoint"
  | "incompatible_checkpoint";

export class DurableContinuationError extends Error {
  readonly recoverable = true;

  constructor(
    readonly code: DurableContinuationErrorCode,
    message: string,
    readonly expectedCompatibilityVersion: string,
    readonly actualCompatibilityVersion: string | null,
  ) {
    super(message);
    this.name = "DurableContinuationError";
  }
}

export interface DurableGraphContinuationOptions<Resume, Result> {
  expectedCompatibilityVersion: string;
  getState: () => Promise<StateSnapshot>;
  invokeResume: (
    command: CommandInstance<Resume, any, any>,
  ) => Promise<Result>;
  resume: Resume;
  readCompatibilityVersion?: (snapshot: StateSnapshot) => unknown;
}

/**
 * Resumes a persisted interrupt only after proving that a compatible checkpoint
 * exists. Callers supply closures so the guard works with any compiled graph
 * while preserving that graph's exact input and output types.
 */
export async function resumeDurableGraph<Resume, Result>(
  options: DurableGraphContinuationOptions<Resume, Result>,
): Promise<Result> {
  const snapshot = await options.getState();
  const checkpointId = snapshot.config.configurable?.checkpoint_id;
  if (typeof checkpointId !== "string" || checkpointId.length === 0) {
    throw new DurableContinuationError(
      "missing_checkpoint",
      "This run cannot be resumed because its checkpoint is missing.",
      options.expectedCompatibilityVersion,
      null,
    );
  }

  const actualVersion = normalizeVersion(
    options.readCompatibilityVersion
      ? options.readCompatibilityVersion(snapshot)
      : defaultCompatibilityVersion(snapshot),
  );
  if (actualVersion !== options.expectedCompatibilityVersion) {
    throw new DurableContinuationError(
      "incompatible_checkpoint",
      actualVersion
        ? `This run uses checkpoint compatibility version "${actualVersion}", but "${options.expectedCompatibilityVersion}" is required.`
        : `This run has no checkpoint compatibility version; "${options.expectedCompatibilityVersion}" is required.`,
      options.expectedCompatibilityVersion,
      actualVersion,
    );
  }

  return options.invokeResume(new Command({ resume: options.resume }));
}

function defaultCompatibilityVersion(snapshot: StateSnapshot): unknown {
  if (
    snapshot.values &&
    typeof snapshot.values === "object" &&
    !Array.isArray(snapshot.values)
  ) {
    return (snapshot.values as Record<string, unknown>).compatibilityVersion;
  }
  return undefined;
}

function normalizeVersion(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
