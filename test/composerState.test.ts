import assert from "node:assert/strict";
import {
  resolveComposerControlState,
} from "../src/composerState";

assert.deepEqual(resolveComposerControlState(false, "", true), {
  action: "send",
  disabled: true,
  icon: "→",
  label: "Send message",
});
assert.deepEqual(resolveComposerControlState(false, "  hello  ", true), {
  action: "send",
  disabled: false,
  icon: "→",
  label: "Send message",
});
assert.deepEqual(resolveComposerControlState(false, "hello", false), {
  action: "send",
  disabled: true,
  icon: "→",
  label: "Select an agent before sending",
});
assert.deepEqual(resolveComposerControlState(true, " \n", true), {
  action: "stop",
  disabled: false,
  icon: "■",
  label: "Stop active run",
});
assert.deepEqual(resolveComposerControlState(true, "steer this run", true), {
  action: "steer",
  disabled: false,
  icon: "↑",
  label: "Send steering message",
});
assert.equal(
  resolveComposerControlState(true, "steer", false).action,
  "steer",
  "the selected agent is fixed for an active run and must not disable steering",
);

console.log(
  "Composer state test passed: idle send, running stop, and running steer states are deterministic",
);
