import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";

const tests = [
  "adapter.integration",
  "approval.integration",
  "conversationReplayProjection.test",
  "executeCommandTool.test",
  "command.integration",
  "sqliteCheckpointer.integration",
  "interruptedContinuation.integration",
  "persistenceService.integration",
  "recovery.integration",
  "repositories.integration",
];

await esbuild.build({
  entryPoints: tests.map((name) => `test/${name}.ts`),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outdir: "dist/test",
  outExtension: { ".js": ".cjs" },
  alias: {
    vscode: "./test/mock-vscode.ts",
  },
  logLevel: "silent",
});

for (const test of tests) {
  const result = spawnSync(
    process.execPath,
    [`dist/test/${test}.cjs`],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
