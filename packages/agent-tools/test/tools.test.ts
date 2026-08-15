import assert from "node:assert/strict";
import test from "node:test";

import { SessionId } from "@mn/agent-protocol";
import {
  JsonSchemaError,
  ToolExecutionError,
  ToolRegistry,
  assertSupportedJsonSchema,
  defineTool,
  validateJsonSchemaValue
} from "../src/index.js";

const parameters = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false
};
const context = { sessionId: SessionId("session-tools") };

test("enforced JSON Schema subset rejects unsupported keywords and validates values", () => {
  assert.throws(
    () => assertSupportedJsonSchema({ type: "string", pattern: ".*" }),
    JsonSchemaError
  );
  assert.deepEqual(validateJsonSchemaValue(parameters, { path: "README.md" }), []);
  assert.deepEqual(validateJsonSchemaValue(parameters, {}), ['missing required property "path"']);
  assert.deepEqual(validateJsonSchemaValue(parameters, { path: "a", extra: true }), ['"extra" is not a declared property']);
});

test("registry requires an authorizer and seals duplicate/static registration", () => {
  assert.throws(() => new ToolRegistry(undefined as never), /authorizer is required/i);
  const registry = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  const tool = defineTool({
    name: "read",
    description: "Read a path",
    risk: "read-only",
    parameters,
    execute: async (args) => ({ path: String(args.path) })
  });
  registry.register(tool);
  assert.throws(() => registry.register(tool), /already registered/i);
  registry.seal();
  assert.throws(() => registry.register({ ...tool, name: "late" }), /sealed/i);
  assert.deepEqual(registry.schemas(), [{ name: "read", description: "Read a path", parameters }]);
});

test("tool execution distinguishes parse, authorization, and redacted handler failures", async () => {
  let invoked = 0;
  const denied = new ToolRegistry({ authorize: async () => ({ decision: "deny" }) });
  denied.register(defineTool({
    name: "write",
    description: "Write a path",
    risk: "side-effecting",
    parameters,
    execute: async () => {
      invoked += 1;
      return null;
    }
  }));
  await assert.rejects(
    denied.execute({ name: "write", arguments: "not-json", context }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === "INVALID_ARGUMENTS"
  );
  await assert.rejects(
    denied.execute({ name: "write", arguments: '{"path":"a"}', context }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === "TOOL_DENIED"
  );
  assert.equal(invoked, 0);

  const approved = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  approved.register(defineTool({
    name: "explode",
    description: "Fail",
    risk: "read-only",
    parameters,
    execute: async () => { throw new Error("password=hunter2"); }
  }));
  await assert.rejects(
    approved.execute({ name: "explode", arguments: '{"path":"a"}', context }),
    (error: unknown) => error instanceof ToolExecutionError
      && error.code === "TOOL_EXECUTION_FAILED"
      && !error.message.includes("hunter2")
  );
});

test("tool handlers execute serially and publish detached JSON results", async () => {
  const order: string[] = [];
  const registry = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  registry.register(defineTool({
    name: "serial",
    description: "Serialize",
    risk: "read-only",
    parameters,
    execute: async (args) => {
      const path = String(args.path);
      order.push(`start:${path}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push(`end:${path}`);
      return { path };
    }
  }));
  const [first, second] = await Promise.all([
    registry.execute({ name: "serial", arguments: '{"path":"a"}', context }),
    registry.execute({ name: "serial", arguments: '{"path":"b"}', context })
  ]);
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
  assert.deepEqual(first, { path: "a" });
  assert.deepEqual(second, { path: "b" });
  assert.notEqual(first, second);
});

test("registry unregisters idempotently and contains lookup, policy, schema, and result errors", async () => {
  const authorizerFailure = new ToolRegistry({ authorize: async () => { throw new Error("token=secret"); } });
  const tool = defineTool({
    name: "read",
    description: "Read",
    risk: "read-only",
    parameters,
    execute: async () => ({ ok: true })
  });
  const unregister = authorizerFailure.register(tool);
  await assert.rejects(
    authorizerFailure.execute({ name: "missing", arguments: "{}", context }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === "TOOL_NOT_FOUND"
  );
  await assert.rejects(
    authorizerFailure.execute({ name: "read", arguments: "{}", context }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === "INVALID_ARGUMENTS"
  );
  await assert.rejects(
    authorizerFailure.execute({ name: "read", arguments: '{"path":"a"}', context }),
    (error: unknown) => error instanceof ToolExecutionError
      && error.code === "TOOL_AUTHORIZATION_FAILED"
      && !error.message.includes("secret")
  );
  unregister();
  unregister();
  assert.deepEqual(authorizerFailure.schemas(), []);

  const invalidResult = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  invalidResult.register(defineTool({
    name: "invalid_result",
    description: "Invalid result",
    risk: "read-only",
    parameters,
    execute: async () => undefined as never
  }));
  await assert.rejects(
    invalidResult.execute({ name: "invalid_result", arguments: '{"path":"a"}', context }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === "TOOL_EXECUTION_FAILED"
  );
});
