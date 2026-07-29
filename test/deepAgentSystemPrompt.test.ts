import assert from "node:assert/strict";
import {
  configureDeepAgentSystemPrompt,
} from "../src/deepAgentSystemPrompt";

const instructions = "Follow the selected project agent instructions.";

assert.equal(
  configureDeepAgentSystemPrompt(instructions, true),
  instructions,
);
assert.deepEqual(
  configureDeepAgentSystemPrompt(instructions, false),
  {
    prefix: instructions,
    base: null,
  },
);

console.log(
  "Deep Agent system prompt test passed: the default base prompt can be included or omitted",
);
