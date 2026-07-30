import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";

const tests = [
  "adapter.integration",
  "agentToolPolicy.test",
  "agentToolPolicy.integration",
  "approval.integration",
  "conversationReplayProjection.test",
  "deepAgentSystemPrompt.test",
  "executeCommandTool.test",
  "projectCustomizations.test",
  "projectAgentRegistry.test",
  "projectAgentDelegation.test",
  "projectAgentDelegation.integration",
  "projectSkillsMiddleware.test",
  "projectSkillsMiddleware.integration",
  "vscodeLanguageModelTools.test",
  "runtimeDiagnostics.test",
  "vscodeToolAdapter.integration",
  "mcpFixture.integration",
  "markdownRenderer.test",
  "vscodeMcpTools.integration",
  "vscodeWebBrowserTools.integration",
  "command.integration",
  "composerState.test",
  "steeringQueue.test",
  "steeringQueue.integration",
  "repeatedToolFailure.test",
  "repeatedToolFailure.integration",
  "sqliteCheckpointer.integration",
  "toolExecutionLedger.integration",
  "workspaceMutationCoordinator.integration",
  "pendingApprovalRecovery.integration",
  "interruptedContinuation.integration",
  "futureGoal.integration",
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
