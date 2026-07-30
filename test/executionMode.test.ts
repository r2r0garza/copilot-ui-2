import assert from "node:assert/strict";
import {
  DEFAULT_EXECUTION_MODE,
  isExecutionMode,
  shouldAutoApprove,
} from "../src/executionMode";

assert.equal(DEFAULT_EXECUTION_MODE, "default");
assert.equal(isExecutionMode("default"), true);
assert.equal(isExecutionMode("auto"), true);
assert.equal(isExecutionMode("plan"), false);
assert.equal(isExecutionMode(undefined), false);
assert.equal(shouldAutoApprove("default"), false);
assert.equal(shouldAutoApprove("auto"), true);

console.log(
  "Execution mode test passed: Default is the reset state and only Auto bypasses user approval",
);
