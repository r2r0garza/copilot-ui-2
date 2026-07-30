import assert from "node:assert/strict";
import { ToolMessage } from "@langchain/core/messages";
import {
  createRepeatedToolNonProgressMiddleware,
  RepeatedToolNonProgressError,
} from "../src/repeatedToolNonProgress";

async function main(): Promise<void> {
  assert.throws(
    () => createRepeatedToolNonProgressMiddleware(0),
    /positive integer/,
  );

  const middleware = createRepeatedToolNonProgressMiddleware(3);
  assert.ok(middleware.wrapToolCall);
  assert.ok(middleware.wrapModelCall);
  const success = async (
    request: ReturnType<typeof toolRequest>,
    content = "[]",
  ) =>
    new ToolMessage({
      content,
      tool_call_id: request.toolCall.id,
      name: request.toolCall.name,
    });

  const first = await middleware.wrapToolCall!(
    toolRequest("call-1", { selector: ".old" }) as never,
    success as never,
  );
  const changedInput = await middleware.wrapToolCall!(
    toolRequest("call-2", { selector: ".new" }) as never,
    success as never,
  );
  const changedResult = await middleware.wrapToolCall!(
    toolRequest("call-3", { selector: ".new" }) as never,
    ((request: ReturnType<typeof toolRequest>) =>
      success(request, "[{\"title\":\"Found\"}]")) as never,
  );
  assert.ok(ToolMessage.isInstance(first));
  assert.ok(ToolMessage.isInstance(changedInput));
  assert.ok(ToolMessage.isInstance(changedResult));
  assert.notEqual(changedResult.status, "error");

  await middleware.wrapToolCall!(
    toolRequest("call-4", { selector: ".old" }) as never,
    success as never,
  );
  await middleware.wrapToolCall!(
    toolRequest("call-5", { selector: ".old" }) as never,
    success as never,
  );
  const terminal = await middleware.wrapToolCall!(
    toolRequest("call-6", { selector: ".old" }) as never,
    success as never,
  );
  assert.ok(ToolMessage.isInstance(terminal));
  assert.equal(terminal.status, "error");
  assert.match(String(terminal.content), /identical result 3 times/);
  assert.match(String(terminal.content), /produced no new information/);

  let handlerCalls = 0;
  const blockedAfterLimit = await middleware.wrapToolCall!(
    toolRequest("call-7", { selector: ".different" }) as never,
    (async () => {
      handlerCalls += 1;
      throw new Error("must not execute");
    }) as never,
  );
  assert.ok(ToolMessage.isInstance(blockedAfterLimit));
  assert.equal(handlerCalls, 0);

  const modelRequest = {
    tools: [{ name: "fixture_lookup" }],
    systemMessage: {
      concat(text: string) {
        return `base\n${text}`;
      },
    },
  };
  let receivedRequest: typeof modelRequest | undefined;
  await middleware.wrapModelCall!(
    modelRequest as never,
    (async (request: typeof modelRequest) => {
      receivedRequest = request;
      return new ToolMessage({
        content: "final explanation",
        tool_call_id: "model",
      });
    }) as never,
  );
  assert.deepEqual(receivedRequest?.tools, []);
  assert.match(
    String(receivedRequest?.systemMessage),
    /identical result 3 times/,
  );

  await assert.rejects(
    async () =>
      middleware.wrapModelCall!(
        modelRequest as never,
        (async () => {
          throw new Error("must not reach provider");
        }) as never,
      ),
    RepeatedToolNonProgressError,
  );

  console.log(
    "Repeated tool non-progress test passed: changed evidence resets counting and three identical successes terminate the loop",
  );
}

function toolRequest(id: string, args: Record<string, unknown>) {
  return {
    toolCall: {
      id,
      name: "fixture_lookup",
      args,
      type: "tool_call" as const,
    },
    tool: undefined,
    state: { messages: [] },
    runtime: {},
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
