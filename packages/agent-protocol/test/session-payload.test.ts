// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_MARKER,
  PHONE_MARKER,
  PRC_ID_MARKER
} from "@mn/data-policy";

import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  CallId,
  CandidateId,
  Digest,
  MessageId,
  PROTECTION_POLICY_DIGEST_V1,
  RunId,
  SessionId,
  UNBOUND_PROTECTED_TOOL_CALL_V1,
  assertAgentSessionProtectedPayloadV1,
  createAssistantMessage,
  createProtectedTextV1,
  createProtectedJsonViewV1,
  createRuntimeEffectCommitmentBinderV1,
  createToolResultMessage,
  createUserMessage,
  digestJson,
  deriveToolEffectKindV1,
  inspectAgentSessionProtectedPayloadV1,
  isAgentSessionProtectedPayloadV1,
  protectAgentSessionPayloadV1
} from "../src/index.js";

const mainlandMobile = ["138", "0013", "8000"].join("");
const prcIdentity = ["110105", "19491231", "002", "X"].join("");
const providerCredential = ["sk", "-", "synthetic", "-", "credential", "-", "material"].join("");

test("session payload builder publishes only a detached protected DTO under the fixed profile", () => {
  const ordinary = [
    "姓名：张三",
    "邮箱：alice@example.com",
    "地址：上海市浦东新区世纪大道 1 号",
    "路径：/Users/alice/work/木牛",
    "模型文本：ordinary thinking text"
  ].join(" | ");
  const payload = protectAgentSessionPayloadV1("user/message", {
    turn: 1,
    message: createUserMessage({
      id: MessageId("message-ordinary-1"),
      source: { kind: "user" },
      content: [{
        type: "text",
        text: `${ordinary} | 手机：${mainlandMobile} | 身份证：${prcIdentity} | api_key=${providerCredential}`
      }]
    })
  });

  const serialized = JSON.stringify(payload);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.kind, "agent-session-protected-payload");
  assert.equal(payload.eventType, "user/message");
  assert.equal(payload.protectionProfile, AGENT_SESSION_PROTECTION_PROFILE_V1);
  assert.equal(payload.protectionPolicyDigest, PROTECTION_POLICY_DIGEST_V1);
  assert.match(serialized, new RegExp(PHONE_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
  assert.match(serialized, new RegExp(PRC_ID_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
  assert.match(serialized, new RegExp(CREDENTIAL_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
  assert.equal(serialized.includes(mainlandMobile), false);
  assert.equal(serialized.includes(prcIdentity), false);
  assert.equal(serialized.includes(providerCredential), false);
  assert.ok(serialized.includes(ordinary));
  assert.match(payload.digest, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.protectedContent), true);
  const inspected = inspectAgentSessionProtectedPayloadV1("user/message", payload);
  assert.deepEqual(inspected, payload);
  assert.notEqual(inspected, payload);
  assert.equal(inspectAgentSessionProtectedPayloadV1("turn/start", payload), undefined);
});

test("assistant proposals stay unbound while explicit tool calls carry a commitment without executable arguments", () => {
  const argumentsText = JSON.stringify({ phone: mainlandMobile, apiKey: providerCredential });
  const assistant = createAssistantMessage({
    id: MessageId("assistant-ordinary-1"),
    source: { kind: "model", provider: "mock", model: "scripted" },
    content: [{
      type: "tool-call",
      id: CallId("call-ordinary-1"),
      name: "read_file",
      arguments: argumentsText
    }]
  });
  const assistantPayload = protectAgentSessionPayloadV1("assistant/message", {
    turn: 1,
    step: 1,
    message: assistant
  });
  const binder = createRuntimeEffectCommitmentBinderV1({
    governanceDigest: "1".repeat(64) as Digest,
    harnessDigest: "2".repeat(64) as Digest
  });
  const handle = binder.bind({
    effectKind: deriveToolEffectKindV1("read_file"),
    sessionId: SessionId("payload-session"),
    runId: RunId("payload-run"),
    candidateId: CandidateId("payload-candidate"),
    turn: 1,
    step: 1,
    internalEffectId: CallId("call-ordinary-1"),
    protectedInput: createProtectedTextV1(argumentsText),
    raw: { kind: "text", value: argumentsText }
  });
  const explicitPayload = protectAgentSessionPayloadV1("tool/call", {
    turn: 1,
    step: 1,
    callId: CallId("call-ordinary-1"),
    name: "read_file",
    arguments: argumentsText,
    commitment: handle.commitment
  });

  const assistantSerialized = JSON.stringify(assistantPayload);
  const explicitSerialized = JSON.stringify(explicitPayload);
  assert.ok(assistantSerialized.includes(UNBOUND_PROTECTED_TOOL_CALL_V1));
  assert.equal(explicitSerialized.includes(UNBOUND_PROTECTED_TOOL_CALL_V1), false);
  assert.deepEqual(explicitPayload.publicControls.binding, handle.commitment);
  for (const [serialized, durableContentKey] of [
    [assistantSerialized, "blocks"],
    [explicitSerialized, "protectedArguments"]
  ] as const) {
    assert.ok(serialized.includes(durableContentKey));
    assert.equal(serialized.includes('"text":"arguments"'), false);
    assert.equal(serialized.includes(mainlandMobile), false);
    assert.equal(serialized.includes(providerCredential), false);
  }
  assert.deepEqual(assistant.content[0], {
    type: "tool-call",
    id: "call-ordinary-1",
    name: "read_file",
    arguments: argumentsText
  });
  binder.dispose();
});

test("session payload builder rejects raw casts, unsafe structural IDs and hostile JSON without invoking user code", () => {
  assert.throws(
    () => protectAgentSessionPayloadV1("turn/start", { turn: 1, extra: true } as never),
    /event-specific|schema/iu
  );
  assert.throws(
    () => protectAgentSessionPayloadV1("turn/start", { turn: 0 } as never),
    /turn|positive/iu
  );
  assert.throws(
    () => protectAgentSessionPayloadV1("step/start", { turn: 1, step: Number.MAX_SAFE_INTEGER + 1 } as never),
    /step|safe integer/iu
  );
  assert.throws(
    () => protectAgentSessionPayloadV1("user/message", {
      turn: 1,
      message: {
        id: MessageId(`message_${mainlandMobile}`),
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "ordinary" }]
      }
    }),
    /protected material/iu
  );
  assert.throws(
    () => protectAgentSessionPayloadV1("tool/call", {
      turn: 1,
      step: 1,
      callId: CallId(`call_${providerCredential}_tail`),
      name: "read_file",
      arguments: "{}",
      commitment: {} as never
    }),
    /protected material/iu
  );

  let getterReads = 0;
  const accessor = Object.defineProperty({}, "turn", {
    enumerable: true,
    get() {
      getterReads += 1;
      return 1;
    }
  });
  assert.throws(
    () => protectAgentSessionPayloadV1("turn/start", accessor as never),
    /data propert|accessor/iu
  );
  assert.equal(getterReads, 0);

  let trapCount = 0;
  const proxy = new Proxy({}, {
    ownKeys() {
      trapCount += 1;
      return [];
    }
  });
  assert.throws(() => protectAgentSessionPayloadV1("turn/start", proxy as never), /Proxy/u);
  assert.equal(trapCount, 0);

  const cyclic: Record<string, unknown> = { turn: 1 };
  cyclic.self = cyclic;
  assert.throws(() => protectAgentSessionPayloadV1("turn/start", cyclic as never), /circular/iu);
  assert.throws(
    () => protectAgentSessionPayloadV1("user/message", {
      turn: 1,
      message: {
        id: MessageId("message-oversized-1"),
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "x".repeat(1_048_577) }]
      }
    }),
    /size|limit/iu
  );
});

test("session profile separates typed counters from protected content and closes message-role block vocabularies", () => {
  const counter = Number(mainlandMobile);
  const assistant = protectAgentSessionPayloadV1("assistant/message", {
    turn: counter,
    step: counter,
    message: createAssistantMessage({
      id: MessageId("assistant-counters-1"),
      source: { kind: "model", provider: "mock", model: "scripted" },
      content: [{ type: "text", text: "ordinary model text" }]
    }),
    usage: {
      inputTokens: counter,
      outputTokens: counter,
      thinkingTokens: counter
    }
  });
  assert.equal(assistant.publicControls.turn, counter);
  assert.equal(assistant.publicControls.step, counter);
  assert.equal(assistant.publicControls.usage?.inputTokens, counter);
  assert.equal(assistant.publicControls.usage?.outputTokens, counter);
  assert.equal(assistant.publicControls.usage?.thinkingTokens, counter);
  assert.equal(JSON.stringify(assistant.protectedContent).includes(mainlandMobile), false);

  const userToolCall = {
    id: MessageId("user-invalid-tool-call-1"),
    role: "user" as const,
    source: { kind: "user" as const },
    content: [{
      type: "tool-call" as const,
      id: CallId("call-user-invalid-1"),
      name: "read_file",
      arguments: "{}"
    }]
  };
  assert.throws(
    () => protectAgentSessionPayloadV1("user/message", { turn: 1, message: userToolCall }),
    /content|user|schema/iu
  );

  const duplicateCalls = createAssistantMessage({
    id: MessageId("assistant-duplicate-calls-1"),
    source: { kind: "model", provider: "mock", model: "scripted" },
    content: [
      { type: "tool-call", id: CallId("call-duplicate-1"), name: "read_file", arguments: "{}" },
      { type: "tool-call", id: CallId("call-duplicate-1"), name: "write_file", arguments: "{}" }
    ]
  });
  assert.throws(
    () => protectAgentSessionPayloadV1("assistant/message", { turn: 1, step: 1, message: duplicateCalls }),
    /duplicate|call identifier/iu
  );
});

test("all nine protected payload variants survive JSON roundtrip without exposing raw content", () => {
  const toolArguments = `password=${providerCredential}`;
  const binder = createRuntimeEffectCommitmentBinderV1({
    governanceDigest: "1".repeat(64) as Digest,
    harnessDigest: "2".repeat(64) as Digest
  });
  const toolHandle = binder.bind({
    effectKind: deriveToolEffectKindV1("read_file"),
    sessionId: SessionId("roundtrip-session"),
    runId: RunId("roundtrip-run"),
    candidateId: CandidateId("roundtrip-candidate"),
    turn: 1,
    step: 1,
    internalEffectId: CallId("call-roundtrip-1"),
    protectedInput: createProtectedTextV1(toolArguments),
    raw: { kind: "text", value: toolArguments }
  });
  const toolResult = createToolResultMessage({
    id: MessageId("tool-result-message-1"),
    source: { kind: "tool", callId: CallId("call-roundtrip-1") },
    content: [{
      type: "tool-result",
      toolCallId: CallId("call-roundtrip-1"),
      content: [{ type: "text", text: `result ${mainlandMobile} api_key=${providerCredential}` }],
      isError: true
    }]
  });
  const fixtures = [
    ["session/created", { cwd: `/Users/alice/${mainlandMobile}`, labels: { owner: "张三" } }],
    ["turn/start", { turn: 1 }],
    ["user/message", {
      turn: 1,
      message: createUserMessage({
        id: MessageId("message-roundtrip-1"),
        source: { kind: "user" },
        content: [{ type: "thinking", text: `thinking ${prcIdentity}` }]
      })
    }],
    ["step/start", { turn: 1, step: 1 }],
    ["assistant/message", {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        id: MessageId("assistant-roundtrip-1"),
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
        content: [{
          type: "tool-call",
          id: CallId("call-roundtrip-1"),
          name: "read_file",
          arguments: JSON.stringify({ phone: mainlandMobile })
        }]
      }),
      usage: { inputTokens: 10, outputTokens: 20 }
    }],
    ["tool/call", {
      turn: 1,
      step: 1,
      callId: CallId("call-roundtrip-1"),
      name: "read_file",
      arguments: toolArguments,
      commitment: toolHandle.commitment
    }],
    ["tool/result", {
      turn: 1,
      step: 1,
      message: toolResult,
      status: "interrupted",
      error: { name: "ToolNotBoundError", code: "TOOL_NOT_BOUND" }
    }],
    ["step/end", { turn: 1, step: 1, status: "interrupted" }],
    ["turn/end", {
      turn: 1,
      reason: "interrupted",
      error: { code: "TURN_INTERRUPTED", message: `phone=${mainlandMobile}` }
    }]
  ] as const;

  for (const [eventType, raw] of fixtures) {
    const payload = protectAgentSessionPayloadV1(eventType, raw as never);
    const encoded = JSON.stringify(payload);
    assert.equal(encoded.includes(mainlandMobile), false, eventType);
    assert.equal(encoded.includes(prcIdentity), false, eventType);
    assert.equal(encoded.includes(providerCredential), false, eventType);
    const decoded: unknown = JSON.parse(encoded);
    assert.equal(isAgentSessionProtectedPayloadV1(eventType, decoded), true, eventType);
    const asserted = assertAgentSessionProtectedPayloadV1(eventType, decoded);
    assert.notEqual(asserted, decoded, eventType);
    assert.equal(Object.isFrozen(asserted), true, eventType);
    const inspected = inspectAgentSessionProtectedPayloadV1(eventType, decoded);
    assert.ok(inspected, eventType);
    assert.equal(Object.isFrozen(inspected), true, eventType);
    assert.equal(Object.isFrozen(inspected.publicControls), true, eventType);
    assert.equal(Object.isFrozen(inspected.protectedContent), true, eventType);
  }
  binder.dispose();
});

test("protected payload inspection rejects expected-type confusion and self-consistent semantic forgeries", () => {
  const original = protectAgentSessionPayloadV1("user/message", {
    turn: 1,
    message: createUserMessage({
      id: MessageId("message-forgery-1"),
      source: { kind: "user" },
      content: [{ type: "text", text: "ordinary" }]
    })
  });
  assert.equal(inspectAgentSessionProtectedPayloadV1("turn/start", original), undefined);

  const typeConfused = structuredClone(original) as unknown as Record<string, unknown>;
  typeConfused.eventType = "turn/start";
  const { digest: _typeDigest, ...typeEnvelope } = typeConfused;
  typeConfused.digest = digestJson(typeEnvelope as never);
  assert.equal(inspectAgentSessionProtectedPayloadV1("turn/start", typeConfused), undefined);

  const wrongProfile = structuredClone(original) as unknown as Record<string, unknown>;
  wrongProfile.protectionProfile = "attacker-profile";
  const { digest: _profileDigest, ...profileEnvelope } = wrongProfile;
  wrongProfile.digest = digestJson(profileEnvelope as never);
  assert.equal(inspectAgentSessionProtectedPayloadV1("user/message", wrongProfile), undefined);

  const wrongPolicy = structuredClone(original) as unknown as Record<string, unknown>;
  wrongPolicy.protectionPolicyDigest = "0".repeat(64);
  const { digest: _policyDigest, ...policyEnvelope } = wrongPolicy;
  wrongPolicy.digest = digestJson(policyEnvelope as never);
  assert.equal(inspectAgentSessionProtectedPayloadV1("user/message", wrongPolicy), undefined);

  const missingControl = structuredClone(original) as unknown as {
    publicControls: { message: { content: unknown[] } };
    digest: string;
    [key: string]: unknown;
  };
  missingControl.publicControls.message.content = [];
  const { digest: _missingDigest, ...missingEnvelope } = missingControl;
  missingControl.digest = digestJson(missingEnvelope as never);
  assert.equal(inspectAgentSessionProtectedPayloadV1("user/message", missingControl), undefined);
});

test("protected session labels preserve colliding protected keys and builder input is detached", () => {
  const secondMobile = ["139", "0013", "8000"].join("");
  const labels: Record<string, string> = {
    [mainlandMobile]: "first owner",
    [secondMobile]: "second owner",
    owner: "张三"
  };
  const raw = { cwd: "/Users/alice/work/木牛", labels };
  const payload = protectAgentSessionPayloadV1("session/created", raw);
  raw.cwd = "/mutated";
  labels.owner = providerCredential;

  const root = payload.protectedContent.root;
  assert.equal(root.type, "object");
  if (root.type !== "object") return;
  const labelsEntry = root.entries.find((entry) => entry.key.text === "labels");
  assert.equal(labelsEntry?.value.type, "object");
  if (labelsEntry?.value.type !== "object") return;
  const protectedPhoneKeys = labelsEntry.value.entries.filter((entry) => entry.key.text === PHONE_MARKER);
  assert.equal(protectedPhoneKeys.length, 2);
  assert.deepEqual(
    protectedPhoneKeys.map((entry) => entry.value.type === "string" ? entry.value.value.text : undefined),
    ["first owner", "second owner"]
  );
  assert.ok(JSON.stringify(payload).includes("/Users/alice/work/木牛"));
  assert.equal(JSON.stringify(payload).includes("/mutated"), false);
  assert.equal(JSON.stringify(payload).includes(providerCredential), false);
});

test("protected payload inspection enforces one aggregate resource budget across controls and content", () => {
  const blockCount = 5_000;
  const publicControls = {
    turn: 1,
    message: {
      id: "message-aggregate-budget-1",
      role: "user",
      source: { kind: "user" },
      content: Array.from({ length: blockCount }, () => ({ type: "text" }))
    }
  };
  const protectedContent = createProtectedJsonViewV1({
    blocks: Array.from({ length: blockCount }, () => "x".repeat(10))
  });
  const envelope = {
    schemaVersion: 1 as const,
    kind: "agent-session-protected-payload" as const,
    eventType: "user/message" as const,
    protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V1,
    protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
    publicControls,
    protectedContent
  };
  const forged = { ...envelope, digest: digestJson(envelope) };
  assert.equal(inspectAgentSessionProtectedPayloadV1("user/message", forged), undefined);
  assert.throws(
    () => protectAgentSessionPayloadV1("user/message", {
      turn: 1,
      message: {
        id: MessageId("message-aggregate-budget-1"),
        role: "user",
        source: { kind: "user" },
        content: Array.from({ length: blockCount }, () => ({ type: "text" as const, text: "x".repeat(10) }))
      }
    }),
    /size limit/iu
  );
});

test("optional protected payload branches remain closed and structural controls never carry credentials", () => {
  for (const status of ["completed", "cancelled", "budget-exceeded", "interrupted", "error"] as const) {
    assert.ok(protectAgentSessionPayloadV1("step/end", { turn: 1, step: 1, status }));
  }
  for (const reason of ["completed", "cancelled", "budget-exceeded", "interrupted", "error"] as const) {
    assert.ok(protectAgentSessionPayloadV1("turn/end", { turn: 1, reason }));
  }
  assert.ok(protectAgentSessionPayloadV1("session/created", {}));

  const ordinaryAssistant = createAssistantMessage({
    id: MessageId("assistant-closed-1"),
    source: { kind: "model", provider: "mock", model: "scripted" },
    content: [{ type: "text", text: "ordinary" }]
  });
  assert.throws(
    () => protectAgentSessionPayloadV1("assistant/message", {
      turn: 1,
      step: 1,
      message: ordinaryAssistant,
      usage: { inputTokens: -1, outputTokens: 0 }
    } as never),
    /event-specific|schema/iu
  );
  assert.throws(
    () => protectAgentSessionPayloadV1("assistant/message", {
      turn: 1,
      step: 1,
      message: {
        ...ordinaryAssistant,
        source: { kind: "model", provider: providerCredential, model: "scripted" }
      }
    }),
    /protected material/iu
  );
  assert.throws(
    () => protectAgentSessionPayloadV1("session/created", {
      labels: { invalid: 1 }
    } as never),
    /event-specific|schema/iu
  );

  const mismatchedToolResult = createToolResultMessage({
    id: MessageId("tool-result-mismatch-1"),
    source: { kind: "tool", callId: CallId("call-source-1") },
    content: [{
      type: "tool-result",
      toolCallId: CallId("call-block-2"),
      content: [{ type: "text", text: "ordinary" }]
    }]
  });
  assert.throws(
    () => protectAgentSessionPayloadV1("tool/result", {
      turn: 1,
      step: 1,
      message: mismatchedToolResult,
      status: "completed"
    }),
    /call identifiers/iu
  );
  assert.throws(
    () => protectAgentSessionPayloadV1("turn/end", {
      turn: 1,
      reason: "error",
      error: { code: `TOKEN:${providerCredential}`, message: "ordinary" }
    }),
    /protected material/iu
  );
});

test("protected payload predicates reject hostile containers and exact-schema extensions without traps", () => {
  const valid = protectAgentSessionPayloadV1("turn/start", { turn: 1 });
  const extra = { ...structuredClone(valid), extra: true };
  assert.equal(isAgentSessionProtectedPayloadV1("turn/start", extra), false);
  assert.throws(
    () => assertAgentSessionProtectedPayloadV1("turn/start", extra),
    (error: unknown) => error instanceof TypeError
      && error.message === "value does not match the event-specific protected session payload schema"
  );

  let traps = 0;
  const hostile = new Proxy({}, {
    ownKeys() {
      traps += 1;
      return [];
    }
  });
  assert.equal(isAgentSessionProtectedPayloadV1("turn/start", hostile), false);
  assert.equal(traps, 0);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(isAgentSessionProtectedPayloadV1("turn/start", revoked.proxy), false);
  assert.equal(inspectAgentSessionProtectedPayloadV1("plugin/arbitrary" as never, valid), undefined);
});

test("assertion returns a detached frozen DTO instead of branding a mutable caller alias", () => {
  const encoded = JSON.stringify(protectAgentSessionPayloadV1("turn/start", { turn: 1 }));
  const decoded = JSON.parse(encoded) as { publicControls: { turn: number } };
  const asserted = assertAgentSessionProtectedPayloadV1("turn/start", decoded);
  assert.notEqual(asserted, decoded);
  assert.equal(Object.isFrozen(asserted), true);
  assert.equal(Object.isFrozen(asserted.publicControls), true);
  decoded.publicControls.turn = 2;
  assert.equal(asserted.publicControls.turn, 1);
});
