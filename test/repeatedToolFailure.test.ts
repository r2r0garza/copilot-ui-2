import assert from "node:assert/strict";
import { ToolMessage } from "@langchain/core/messages";
import {
  createRepeatedToolFailureMiddleware,
  RepeatedToolFailureError,
} from "../src/repeatedToolFailure";

async function main(): Promise<void> {
  assert.throws(
    () => createRepeatedToolFailureMiddleware(0),
    /positive integer/,
  );

  const middleware = createRepeatedToolFailureMiddleware(3);
  assert.ok(middleware.wrapToolCall);
  assert.ok(middleware.wrapModelCall);
  const failure = async (request: ReturnType<typeof toolRequest>) =>
    new ToolMessage({
      content: "Error: file does not exist",
      tool_call_id: request.toolCall.id,
      name: request.toolCall.name,
      status: "error",
    });

  const first = await middleware.wrapToolCall!(
    toolRequest("call-1", { path: "missing.txt" }) as never,
    failure as never,
  );
  const different = await middleware.wrapToolCall!(
    toolRequest("call-2", { path: "other.txt" }) as never,
    failure as never,
  );
  const second = await middleware.wrapToolCall!(
    toolRequest("call-3", { path: "missing.txt" }) as never,
    failure as never,
  );
  assert.ok(ToolMessage.isInstance(first));
  assert.ok(ToolMessage.isInstance(different));
  assert.ok(ToolMessage.isInstance(second));
  assert.doesNotMatch(String(first.content), /limit reached/);
  assert.doesNotMatch(String(different.content), /limit reached/);
  assert.doesNotMatch(String(second.content), /limit reached/);

  const success = await middleware.wrapToolCall!(
    toolRequest("call-4", { path: "missing.txt" }) as never,
    (async (request: ReturnType<typeof toolRequest>) =>
      new ToolMessage({
        content: "contents",
        tool_call_id: request.toolCall.id,
        name: request.toolCall.name,
      })) as never,
  );
  assert.ok(ToolMessage.isInstance(success));
  assert.equal(success.status, undefined);

  await middleware.wrapToolCall!(
    toolRequest("call-5", { path: "missing.txt" }) as never,
    failure as never,
  );
  await middleware.wrapToolCall!(
    toolRequest("call-6", { path: "missing.txt" }) as never,
    failure as never,
  );
  const terminal = await middleware.wrapToolCall!(
    toolRequest("call-7", { path: "missing.txt" }) as never,
    failure as never,
  );
  assert.ok(ToolMessage.isInstance(terminal));
  assert.match(String(terminal.content), /same error 3 times/);
  assert.match(String(terminal.content), /No more tools are available/);

  let handlerCalls = 0;
  const blockedAfterLimit = await middleware.wrapToolCall!(
    toolRequest("call-8", { path: "another.txt" }) as never,
    (async () => {
      handlerCalls += 1;
      throw new Error("must not execute");
    }) as never,
  );
  assert.ok(ToolMessage.isInstance(blockedAfterLimit));
  assert.equal(handlerCalls, 0);
  assert.equal(blockedAfterLimit.status, "error");

  const modelRequest = {
    tools: [{ name: "read_file" }],
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
  assert.match(String(receivedRequest?.systemMessage), /same error 3 times/);

  await assert.rejects(
    async () =>
      middleware.wrapModelCall!(
        modelRequest as never,
        (async () => {
          throw new Error("must not reach provider");
        }) as never,
      ),
    RepeatedToolFailureError,
  );

  console.log(
    "Repeated tool failure test passed: equivalent-input counting, success reset, terminal no-tools response, and hard bound",
  );
}

function toolRequest(id: string, args: Record<string, unknown>) {
  return {
    toolCall: {
      id,
      name: "read_file",
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
