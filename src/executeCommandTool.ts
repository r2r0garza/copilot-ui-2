import { spawn } from "node:child_process";
import * as path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_OUTPUT_BYTES = 100_000;

export interface ExecuteCommandToolOptions {
  workspaceRoot: string;
}

export interface ExecuteCommandInput {
  executable: string;
  args: string[];
  timeout_seconds: number;
}

export interface ExecuteCommandResult {
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  durationMs: number;
}

export function createExecuteCommandTool(options: ExecuteCommandToolOptions) {
  return tool(
    async (
      input: ExecuteCommandInput,
      config,
    ): Promise<string> => {
      const result = await executeCommand(
        input,
        options.workspaceRoot,
        config?.signal,
      );
      return JSON.stringify(result, null, 2);
    },
    {
      name: "execute_command",
      description: [
        "Execute one program in the current VS Code workspace and return its exit code, stdout, and stderr.",
        "Use this for builds, tests, linters, and other development commands.",
        "Call this tool directly when execution is needed. Do not ask the user for permission in conversational text; the host application displays the real approval UI.",
        "Provide the executable and each argument separately. Shell syntax such as pipes, redirects, variable expansion, and && is not interpreted.",
        "Parent-directory traversal, path-expansion tokens, and absolute argument paths outside the workspace are rejected.",
        "For the workspace directory, omit the path argument or use '.' exactly. Never substitute '/', a home directory, or another absolute path.",
        "Invocations require user approval unless command execution was allowed for the current chat session.",
      ].join(" "),
      schema: z.object({
        executable: z
          .string()
          .min(1)
          .describe("Program to execute, for example npm, node, git, or python."),
        args: z
          .array(z.string())
          .default([])
          .describe("Argument vector passed directly to the executable."),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_SECONDS)
          .default(DEFAULT_TIMEOUT_SECONDS)
          .describe(`Execution timeout in seconds, up to ${MAX_TIMEOUT_SECONDS}.`),
      }),
    },
  );
}

export async function executeCommand(
  input: ExecuteCommandInput,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<ExecuteCommandResult> {
  validateExecuteCommandInput(input, workspaceRoot);

  return new Promise<ExecuteCommandResult>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(input.executable, input.args, {
      cwd: workspaceRoot,
      env: createCommandEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let remainingBytes = MAX_OUTPUT_BYTES;
    let outputTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const capture = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const length = Math.min(buffer.length, remainingBytes);
      if (length > 0) {
        target.push(buffer.subarray(0, length));
        remainingBytes -= length;
      }
      if (length < buffer.length) {
        outputTruncated = true;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const terminate = (): void => {
      if (child.exitCode !== null || child.killed) {
        return;
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1_000);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeout_seconds * 1_000);

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      signal?.removeEventListener("abort", onAbort);
    };

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.once("close", (exitCode, exitSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (aborted) {
        reject(new Error("Command execution cancelled."));
        return;
      }
      resolve({
        executable: input.executable,
        args: input.args,
        cwd: workspaceRoot,
        exitCode,
        signal: exitSignal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputTruncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export function validateExecuteCommandInput(
  input: Pick<ExecuteCommandInput, "executable" | "args">,
  workspaceRoot: string,
): void {
  validateProcessValue(input.executable, "executable");
  for (const arg of input.args) {
    validateProcessValue(arg, "argument");
    validateArgumentPath(arg, workspaceRoot);
  }
}

function validateProcessValue(value: string, label: string): void {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`Command ${label} contains an unsupported control character.`);
  }
  if (value.includes("..")) {
    throw new Error(
      `Command ${label} contains '..'; parent-directory traversal is not allowed.`,
    );
  }
  if (
    value.includes("~") ||
    /\$(?:\{)?(?:HOME|PWD|OLDPWD)(?:\})?/i.test(value) ||
    /%(?:USERPROFILE|HOMEDRIVE|HOMEPATH|CD)%/i.test(value)
  ) {
    throw new Error(
      `Command ${label} contains a path-expansion token; path expansion is not allowed.`,
    );
  }
}

function validateArgumentPath(value: string, workspaceRoot: string): void {
  const candidates = [value];
  const equalsIndex = value.indexOf("=");
  if (equalsIndex >= 0 && equalsIndex < value.length - 1) {
    candidates.push(value.slice(equalsIndex + 1));
  }

  for (const rawCandidate of candidates) {
    const candidate = stripMatchingQuotes(rawCandidate);
    if (path.isAbsolute(candidate)) {
      if (!isPathInside(workspaceRoot, candidate, path)) {
        throw new Error(
          `Command argument contains an absolute path outside the workspace: ${candidate}`,
        );
      }
    } else if (path.win32.isAbsolute(candidate)) {
      if (
        process.platform !== "win32" ||
        !isPathInside(workspaceRoot, candidate, path.win32)
      ) {
        throw new Error(
          `Command argument contains an absolute path outside the workspace: ${candidate}`,
        );
      }
    }
  }
}

function isPathInside(
  workspaceRoot: string,
  candidate: string,
  pathApi: path.PlatformPath,
): boolean {
  const relativePath = pathApi.relative(
    pathApi.resolve(workspaceRoot),
    pathApi.resolve(candidate),
  );
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relativePath))
  );
}

function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function createCommandEnvironment(): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  environment.NO_COLOR = "1";
  environment.DEEPAGENTS_COMMAND = "1";
  return environment;
}
