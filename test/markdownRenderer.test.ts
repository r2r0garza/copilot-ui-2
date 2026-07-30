import assert from "node:assert/strict";
import { renderMarkdown } from "../src/markdownRenderer";

const rendered = renderMarkdown([
  "- /delegation-fixture.txt (delegation-reader) returned:",
  "```text",
  "alpha:project-agent-delegation",
  "```",
  "",
  "- tests/SQUIRREL.md (delegation-reader) returned:",
  "```text",
  "autumn alley path",
  "a gray squirrel pauses there",
  "acorn in cold paws",
  "```",
].join("\n"));

assert.match(rendered, /<ul>/);
assert.match(rendered, /<li>\/delegation-fixture\.txt/);
assert.match(rendered, /<pre><code class="language-text">/);
assert.doesNotMatch(rendered, /```/);

const unsafe = renderMarkdown(
  "[bad](javascript:alert(1)) <script>alert('x')</script>",
);
assert.doesNotMatch(unsafe, /href=/);
assert.doesNotMatch(unsafe, /<script/);

console.log(
  "Markdown renderer test passed: block syntax renders and unsafe HTML is removed",
);
