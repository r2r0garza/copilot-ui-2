import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "../src/executeCommandTool";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "execute-command-tool-"));
  const secretName = "DEEPAGENTS_TEST_SECRET";
  const previousSecret = process.env[secretName];
  process.env[secretName] = "must-not-leak";

  try {
    const result = await executeCommand(
      {
        executable: process.execPath,
        args: [
          "-e",
          [
            "console.log(process.cwd())",
            `console.log(process.env.${secretName} ?? 'scrubbed')`,
            "console.error('stderr works')",
          ].join(";"),
        ],
        timeout_seconds: 10,
      },
      root,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.cwd, root);
    assert.ok(result.stdout.includes(root));
    assert.ok(result.stdout.includes("scrubbed"));
    assert.ok(!result.stdout.includes("must-not-leak"));
    assert.ok(result.stderr.includes("stderr works"));
    assert.equal(result.outputTruncated, false);
  } finally {
    if (previousSecret === undefined) {
      delete process.env[secretName];
    } else {
      process.env[secretName] = previousSecret;
    }
  }

  await assert.rejects(
    executeCommand(
      {
        executable: `node\nmalicious`,
        args: [],
        timeout_seconds: 10,
      },
      root,
    ),
    /unsupported control character/,
  );

  for (const value of [
    "..",
    "../outside",
    "../../outside",
    "nested/../../../outside",
    String.raw`..\outside`,
    String.raw`nested\..\outside`,
    "--directory=../outside",
  ]) {
    await assert.rejects(
      executeCommand(
        {
          executable: process.execPath,
          args: [value],
          timeout_seconds: 10,
        },
        root,
      ),
      /parent-directory traversal is not allowed/,
      `Expected traversal argument to be rejected: ${value}`,
    );
  }

  await assert.rejects(
    executeCommand(
      {
        executable: "../node",
        args: [],
        timeout_seconds: 10,
      },
      root,
    ),
    /parent-directory traversal is not allowed/,
  );

  for (const value of [
    "~",
    "~/outside",
    "~someone/outside",
    "$HOME/outside",
    "${HOME}/outside",
    "$PWD/outside",
    "%USERPROFILE%\\outside",
  ]) {
    await assert.rejects(
      executeCommand(
        {
          executable: process.execPath,
          args: [value],
          timeout_seconds: 10,
        },
        root,
      ),
      /path expansion is not allowed/,
      `Expected path expansion to be rejected: ${value}`,
    );
  }

  for (const value of [
    tmpdir(),
    `--directory=${tmpdir()}`,
  ]) {
    await assert.rejects(
      executeCommand(
        {
          executable: process.execPath,
          args: [value],
          timeout_seconds: 10,
        },
        root,
      ),
      /absolute path outside the workspace/,
      `Expected outside absolute path to be rejected: ${value}`,
    );
  }

  const workspaceAbsolutePath = await executeCommand(
    {
      executable: process.execPath,
      args: ["-e", "console.log(process.argv[1])", root],
      timeout_seconds: 10,
    },
    root,
  );
  assert.equal(workspaceAbsolutePath.exitCode, 0);
  assert.ok(workspaceAbsolutePath.stdout.includes(root));

  console.log(
    "Command runner test passed: cwd, environment, output, traversal, expansion, and absolute-path guards",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
