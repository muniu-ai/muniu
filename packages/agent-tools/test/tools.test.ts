import assert from "node:assert/strict";
import test from "node:test";

import { SessionId } from "@mn/agent-protocol";
import {
  JsonSchemaError,
  ToolExecutionError,
  ToolRegistry,
  type ToolDefinition,
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

test("registry reads, validates, and binds the authorizer getter exactly once", async () => {
  let reads = 0;
  const authorizer = {
    marker: "bound",
    get authorize() {
      reads += 1;
      return async function (this: { marker: string }) {
        return { decision: this.marker === "bound" ? "approve" as const : "deny" as const };
      };
    }
  };
  const registry = new ToolRegistry(authorizer);
  registry.register(defineTool({
    name: "bound_authorizer",
    description: "Check stable authorization",
    risk: "read-only",
    parameters,
    execute: async () => ({ ok: true })
  }));

  assert.deepEqual(
    await registry.execute({ name: "bound_authorizer", arguments: '{"path":"a"}', context }),
    { ok: true }
  );
  assert.equal(reads, 1);
});

test("execute synchronously snapshots every invocation getter before queueing and shares one frozen context", async () => {
  let releaseBlocker!: () => void;
  const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  let blockerStarted!: () => void;
  const blockerStart = new Promise<void>((resolve) => { blockerStarted = resolve; });
  let authorizationContext: unknown;
  let handlerContext: unknown;
  const registry = new ToolRegistry({
    authorize: async (request) => {
      if (request.args.path === "queued") authorizationContext = request.context;
      return { decision: "approve" };
    }
  });
  registry.register(defineTool({
    name: "snapshot_invocation",
    description: "Snapshot queued invocation",
    risk: "side-effecting",
    parameters,
    execute: async (args, runContext) => {
      if (args.path === "blocker") {
        blockerStarted();
        await blockerGate;
      } else {
        handlerContext = runContext;
      }
      return { path: String(args.path), sessionId: runContext.sessionId };
    }
  }));

  const blocker = registry.execute({
    name: "snapshot_invocation",
    arguments: '{"path":"blocker"}',
    context
  });
  await blockerStart;

  const originalController = new AbortController();
  const replacementController = new AbortController();
  let name = "snapshot_invocation";
  let argumentsJson = '{"path":"queued"}';
  let sessionId = "snapshot-session";
  let signal = originalController.signal;
  const reads = { name: 0, arguments: 0, context: 0, sessionId: 0, signal: 0 };
  const mutableContext = Object.defineProperties({}, {
    sessionId: { enumerable: true, get: () => { reads.sessionId += 1; return sessionId; } },
    signal: { enumerable: true, get: () => { reads.signal += 1; return signal; } }
  });
  const invocation = Object.defineProperties({}, {
    name: { enumerable: true, get: () => { reads.name += 1; return name; } },
    arguments: { enumerable: true, get: () => { reads.arguments += 1; return argumentsJson; } },
    context: { enumerable: true, get: () => { reads.context += 1; return mutableContext; } }
  });
  const queued = registry.execute(invocation as never);
  assert.deepEqual(reads, { name: 1, arguments: 1, context: 1, sessionId: 1, signal: 1 });

  name = "missing_after_queue";
  argumentsJson = "not-json";
  sessionId = "mutated-session";
  signal = replacementController.signal;
  replacementController.abort();
  releaseBlocker();
  await blocker;
  const result = await queued;

  assert.deepEqual(result, { path: "queued", sessionId: "snapshot-session" });
  assert.equal(authorizationContext, handlerContext);
  assert.equal(Object.isFrozen(authorizationContext), true);
  assert.equal((authorizationContext as { signal?: AbortSignal }).signal, originalController.signal);
  assert.equal(originalController.signal.aborted, false);
  assert.deepEqual(reads, { name: 1, arguments: 1, context: 1, sessionId: 1, signal: 1 });
});

test("tool cancellation before authorization or dispatch never invokes a remaining side effect", async () => {
  let authorizationCount = 0;
  const dispatched: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const registry = new ToolRegistry({ authorize: async () => {
    authorizationCount += 1;
    return { decision: "approve" };
  } });
  registry.register(defineTool({
    name: "cancel_boundary",
    description: "Cancellation boundary",
    risk: "side-effecting",
    parameters,
    execute: async (args) => {
      const value = String(args.path);
      dispatched.push(value);
      if (value === "first") await firstGate;
      return { value };
    }
  }));

  const first = registry.execute({ name: "cancel_boundary", arguments: '{"path":"first"}', context });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const queuedController = new AbortController();
  const queued = registry.execute({
    name: "cancel_boundary",
    arguments: '{"path":"queued"}',
    context: { ...context, signal: queuedController.signal }
  });
  queuedController.abort();
  releaseFirst();
  await first;
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof ToolExecutionError && error.code === "TOOL_CANCELLED"
  );
  assert.deepEqual(dispatched, ["first"]);
  assert.equal(authorizationCount, 1);

  const beforeAuthorizeController = new AbortController();
  const beforeAuthorize = {
    name: "cancel_boundary",
    get arguments() {
      beforeAuthorizeController.abort();
      return '{"path":"before-authorize"}';
    },
    context: { ...context, signal: beforeAuthorizeController.signal }
  };
  await assert.rejects(
    registry.execute(beforeAuthorize),
    (error: unknown) => error instanceof ToolExecutionError && error.code === "TOOL_CANCELLED"
  );
  assert.deepEqual(dispatched, ["first"]);
  assert.equal(authorizationCount, 1);
});

test("tool cancellation after approval or during a handler reports TOOL_CANCELLED", async () => {
  const afterApprovalController = new AbortController();
  let approvalDispatches = 0;
  const afterApproval = new ToolRegistry({ authorize: async () => {
    afterApprovalController.abort();
    return { decision: "approve" };
  } });
  afterApproval.register(defineTool({
    name: "after_approval",
    description: "Cancel after approval",
    risk: "side-effecting",
    parameters,
    execute: async () => { approvalDispatches += 1; return null; }
  }));
  await assert.rejects(
    afterApproval.execute({
      name: "after_approval",
      arguments: '{"path":"a"}',
      context: { ...context, signal: afterApprovalController.signal }
    }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === "TOOL_CANCELLED"
  );
  assert.equal(approvalDispatches, 0);

  const runningController = new AbortController();
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const running = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  running.register(defineTool({
    name: "running_cancel",
    description: "Cancel running handler",
    risk: "side-effecting",
    parameters,
    execute: async () => {
      handlerStarted();
      await handlerGate;
      return { outcome: "potentially-applied" };
    }
  }));
  const execution = running.execute({
    name: "running_cancel",
    arguments: '{"path":"a"}',
    context: { ...context, signal: runningController.signal }
  });
  await started;
  runningController.abort();
  releaseHandler();
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof ToolExecutionError && error.code === "TOOL_CANCELLED"
  );
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

test("handler exceptions cannot forge cancellation or leak an attacker-controlled message", async () => {
  const registry = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  registry.register(defineTool({
    name: "forge_cancel",
    description: "Attempt to forge cancellation",
    risk: "side-effecting",
    parameters,
    execute: async () => {
      throw new ToolExecutionError("secret handler cancellation detail", "TOOL_CANCELLED");
    }
  }));

  await assert.rejects(
    registry.execute({ name: "forge_cancel", arguments: '{"path":"a"}', context }),
    (error: unknown) => error instanceof ToolExecutionError
      && error.code === "TOOL_EXECUTION_FAILED"
      && error.message === "Tool execution failed"
      && !error.message.includes("secret handler")
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

test("authorization and handler receive isolated frozen argument snapshots", async () => {
  let authorizationArgs: Readonly<Record<string, unknown>> | undefined;
  let mutationRejected = false;
  let handlerArgs: Readonly<Record<string, unknown>> | undefined;
  const registry = new ToolRegistry({
    authorize: async (request) => {
      authorizationArgs = request.args;
      await Promise.resolve();
      try {
        (request.args as { path: string }).path = "changed-after-approval";
      } catch (error: unknown) {
        mutationRejected = error instanceof TypeError;
      }
      return { decision: "approve" };
    }
  });
  registry.register(defineTool({
    name: "snapshot",
    description: "Snapshot",
    risk: "side-effecting",
    parameters,
    execute: async (args) => {
      handlerArgs = args;
      return { path: String(args.path) };
    }
  }));
  const result = await registry.execute({ name: "snapshot", arguments: '{"path":"approved"}', context });
  assert.equal(mutationRejected, true);
  assert.equal(Object.isFrozen(authorizationArgs), true);
  assert.equal(Object.isFrozen(handlerArgs), true);
  assert.notEqual(authorizationArgs, handlerArgs);
  assert.deepEqual(result, { path: "approved" });
});

test("registry snapshots and validates ordinary mutable tool definitions", async () => {
  let invoked = "none";
  let authorizedRisk: string | undefined;
  const registry = new ToolRegistry({ authorize: async (request) => {
    authorizedRisk = request.risk;
    return { decision: "approve" };
  } });
  const mutable = {
    name: "stable",
    description: "Stable definition",
    risk: "read-only",
    parameters: structuredClone(parameters),
    execute: async () => { invoked = "original"; return null; }
  } as ToolDefinition;
  registry.register(mutable);
  (mutable as unknown as { risk: string }).risk = "side-effecting";
  (mutable as unknown as { execute: () => Promise<null> }).execute = async () => { invoked = "mutated"; return null; };
  (mutable.parameters.properties?.path as { type?: string }).type = "number";

  await registry.execute({ name: "stable", arguments: '{"path":"README.md"}', context });
  assert.equal(invoked, "original");
  assert.equal(authorizedRisk, "read-only");
  assert.deepEqual(registry.schemas()[0]?.parameters, parameters);

  const invalid = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  assert.throws(() => invalid.register({ ...mutable, name: "bad_risk", risk: "unsafe" } as never), /risk/i);
  assert.throws(() => defineTool({
    name: "bad_execute",
    description: "Bad execute",
    risk: "read-only",
    parameters,
    execute: null as never
  }), /execute/i);
});

test("registry reads definition getters once before duplicate checks", async () => {
  let invoked = "none";
  const registry = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  registry.register(defineTool({
    name: "existing",
    description: "Existing",
    risk: "read-only",
    parameters,
    execute: async () => { invoked = "existing"; return null; }
  }));
  let nameReads = 0;
  const getterTool = Object.defineProperties({}, {
    name: { enumerable: true, get: () => (++nameReads === 1 ? "unclaimed" : "existing") },
    description: { enumerable: true, get: () => "Getter tool" },
    risk: { enumerable: true, get: () => "read-only" },
    parameters: { enumerable: true, get: () => parameters },
    execute: { enumerable: true, get: () => async () => { invoked = "getter"; return null; } }
  }) as ToolDefinition;
  registry.register(getterTool);
  assert.equal(nameReads, 1);
  await registry.execute({ name: "existing", arguments: '{"path":"a"}', context });
  assert.equal(invoked, "existing");
  await registry.execute({ name: "unclaimed", arguments: '{"path":"a"}', context });
  assert.equal(invoked, "getter");
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
