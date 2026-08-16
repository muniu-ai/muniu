// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CandidateId,
  Digest,
  RunId,
  SessionId,
  assertEffectCommitmentV1,
  createProtectedJsonViewV1,
  createProtectedTextV1,
  createRuntimeEffectCommitmentBinderV1,
  digestJson,
  isEffectCommitmentV1,
  isRuntimeEffectCommitmentBinderV1,
  type EffectCommitmentBindingV1,
  type EffectPolicyBindingV1,
  type EffectRawInputV1
} from "../src/index.js";
import * as protocol from "../src/index.js";

const rawCredential = ["sk", "-", "runtime", "-", "only", "-", "credential", "-", "material"].join("");
const governanceDigest = Digest("a".repeat(64));
const harnessDigest = Digest("c".repeat(64));
const mainlandMobile = ["138", "0013", "8000"].join("");
const prcIdentity = ["110105", "19491231", "002", "X"].join("");
const awsCredential = ["AKIA", "1234567890ABCDEF"].join("");
const githubCredential = ["ghp", "_", "a".repeat(20)].join("");

function createBinder(
  overrides: Partial<EffectPolicyBindingV1> = {}
) {
  return createRuntimeEffectCommitmentBinderV1({
    governanceDigest,
    harnessDigest,
    ...overrides
  });
}

function binding(
  raw: EffectRawInputV1 = { kind: "text", value: `api_key=${rawCredential}` },
  overrides: Partial<Omit<EffectCommitmentBindingV1, "raw">> = {}
): EffectCommitmentBindingV1 {
  const protectedInput = raw.kind === "text"
    ? createProtectedTextV1(raw.value)
    : createProtectedJsonViewV1(raw.value);
  return {
    effectKind: "tool/shell",
    sessionId: SessionId("session-1"),
    runId: RunId("run-1"),
    candidateId: CandidateId("candidate-1"),
    turn: 1,
    step: 2,
    internalEffectId: "effect-1",
    protectedInput,
    raw,
    ...overrides
  };
}

test("runtime effect commitment uses a full HMAC tag, random nonce and complete immutable domain", () => {
  const binder = createBinder();
  const otherBinder = createBinder();
  const first = binder.bind(binding());
  const second = binder.bind(binding(undefined, { step: 3 }));
  const other = otherBinder.bind(binding());

  assert.deepEqual(Object.keys(first), ["commitment"]);
  assert.equal(first.commitment.schemaVersion, 1);
  assert.equal(first.commitment.scope, "runtime-gate");
  assert.equal(first.commitment.algorithm, "HMAC-SHA-256");
  assert.match(first.commitment.keyId, /^kid_[0-9a-f]{64}$/u);
  assert.equal(first.commitment.keyId, second.commitment.keyId);
  assert.notEqual(first.commitment.keyId, other.commitment.keyId);
  assert.equal(Buffer.from(first.commitment.nonce, "base64url").byteLength, 16);
  assert.match(first.commitment.tag, /^[0-9a-f]{64}$/u);
  assert.notEqual(first.commitment.nonce, second.commitment.nonce);
  assert.notEqual(first.commitment.tag, second.commitment.tag);
  assert.equal(first.commitment.effectKind, "tool/shell");
  assert.equal(first.commitment.sessionId, "session-1");
  assert.equal(first.commitment.runId, "run-1");
  assert.equal(first.commitment.candidateId, "candidate-1");
  assert.equal(first.commitment.turn, 1);
  assert.equal(first.commitment.step, 2);
  assert.equal(first.commitment.internalEffectId, "effect-1");
  assert.equal(first.commitment.protectedInputDigest, binding().protectedInput.digest);
  assert.equal(first.commitment.protectionPolicyDigest, binding().protectedInput.policyDigest);
  assert.match(first.commitment.policyDigest, /^[0-9a-f]{64}$/u);
  assert.equal(first.commitment.policyDigest, second.commitment.policyDigest);
  assert.notEqual(first.commitment.policyDigest, other.commitment.policyDigest);
  assert.equal(first.commitment.rawKind, "text");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.commitment), true);
  assert.equal(isEffectCommitmentV1(first.commitment), true);
  assert.doesNotThrow(() => assertEffectCommitmentV1(first.commitment));

  binder.release(first);
  binder.release(second);
  binder.dispose();
  otherBinder.release(other);
  otherBinder.dispose();
});

test("runtime effect binders have an unforgeable process-local provenance", () => {
  const binder = createBinder();
  const forged = {
    bind: binder.bind,
    verifyAndConsume: binder.verifyAndConsume,
    release: binder.release,
    dispose: binder.dispose
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();

  assert.equal(isRuntimeEffectCommitmentBinderV1(binder), true);
  assert.equal(isRuntimeEffectCommitmentBinderV1(forged), false);
  assert.equal(isRuntimeEffectCommitmentBinderV1(revoked.proxy), false);
  binder.dispose();
  assert.equal(isRuntimeEffectCommitmentBinderV1(binder), false);
});

test("opaque handles verify exactly once and a failed candidate consumes the handle", () => {
  const binder = createBinder();
  const raw: EffectRawInputV1 = { kind: "text", value: `api_key=${rawCredential}` };
  const success = binder.bind(binding(raw));
  assert.equal(binder.verifyAndConsume(success, raw), true);
  assert.equal(binder.verifyAndConsume(success, raw), false);

  const mismatch = binder.bind(binding(raw));
  assert.equal(binder.verifyAndConsume(mismatch, { kind: "text", value: "different" }), false);
  assert.equal(binder.verifyAndConsume(mismatch, raw), false);

  const invalid = binder.bind(binding(raw));
  assert.equal(binder.verifyAndConsume(invalid, { kind: "json", value: undefined } as never), false);
  assert.equal(binder.verifyAndConsume(invalid, raw), false);
  binder.dispose();
});

test("different binders cannot validate a handle and the failed cross-binder attempt consumes it", () => {
  const owner = createBinder();
  const other = createBinder();
  const raw: EffectRawInputV1 = { kind: "text", value: "ordinary command" };
  const handle = owner.bind(binding(raw));

  assert.equal(other.verifyAndConsume(handle, raw), false);
  assert.equal(owner.verifyAndConsume(handle, raw), false);
  owner.dispose();
  other.dispose();
});

test("release and binder disposal invalidate handles and disposal prevents future binding", () => {
  const binder = createBinder();
  const raw: EffectRawInputV1 = { kind: "text", value: "ordinary command" };
  const released = binder.bind(binding(raw));
  binder.release(released);
  binder.release(released);
  assert.equal(binder.verifyAndConsume(released, raw), false);

  const pending = binder.bind(binding(raw));
  binder.dispose();
  binder.dispose();
  assert.equal(binder.verifyAndConsume(pending, raw), false);
  assert.throws(() => binder.bind(binding(raw)), /disposed/u);
});

test("commitment serialization never contains raw input, a raw digest, an HMAC key or a verification oracle", () => {
  const binder = createBinder();
  const handle = binder.bind(binding());
  const serialized = JSON.stringify(handle);

  assert.equal(serialized.includes(rawCredential), false);
  assert.equal(/raw(?:Sha|Digest|Value)|hmacKey|secretKey/iu.test(serialized), false);
  assert.deepEqual(Object.keys(binder).sort(), ["bind", "dispose", "release", "verifyAndConsume"]);
  assert.equal("key" in binder, false);
  assert.equal("verify" in binder, false);
  assert.equal("raw" in handle, false);
  binder.release(handle);
  binder.dispose();
});

test("binding cannot publish a caller-supplied SHA-256 digest of protected raw input", () => {
  const binder = createBinder();
  const raw: EffectRawInputV1 = { kind: "text", value: mainlandMobile };
  const rawSha256 = createHash("sha256").update(mainlandMobile, "utf8").digest("hex");
  const handle = binder.bind(binding(raw));

  assert.equal(JSON.stringify(handle).includes(rawSha256), false);
  assert.equal(handle.commitment.protectedInputDigest, createProtectedTextV1(mainlandMobile).digest);
  assert.throws(
    () => binder.bind({ ...binding(raw), protectedDigest: Digest(rawSha256) } as never),
    /exact|field|binding/iu
  );
  const rawShaPolicyBinding = {
    governanceDigest: Digest(rawSha256),
    harnessDigest
  };
  const rawShaBinder = createRuntimeEffectCommitmentBinderV1(rawShaPolicyBinding);
  const policyHandle = rawShaBinder.bind(binding(raw));
  assert.equal(JSON.stringify(policyHandle).includes(rawSha256), false);
  assert.match(policyHandle.commitment.policyDigest, /^[0-9a-f]{64}$/u);
  const offlineGuesses = ["13900139000", mainlandMobile, "13700137000"].map((candidate) => {
    const candidateDigest = createHash("sha256").update(candidate, "utf8").digest("hex");
    return digestJson({
      schemaVersion: 1,
      scope: "runtime-gate",
      keyId: policyHandle.commitment.keyId,
      governanceDigest: Digest(candidateDigest),
      harnessDigest
    });
  });
  assert.equal(offlineGuesses.includes(policyHandle.commitment.policyDigest), false);
  assert.equal("createEffectPolicyReceiptV1" in protocol, false);
  assert.throws(
    () => binder.bind({ ...binding(raw), policyDigest: Digest(rawSha256) } as never),
    /exact|field|binding/iu
  );
  rawShaBinder.release(policyHandle);
  rawShaBinder.dispose();
  binder.release(handle);
  binder.dispose();
});

test("one binder cannot be queried with policy candidates to recover a low-entropy governance digest", () => {
  const raw: EffectRawInputV1 = { kind: "text", value: "ordinary" };
  const targetGovernanceDigest = Digest(
    createHash("sha256").update(mainlandMobile, "utf8").digest("hex")
  );
  const binder = createBinder({ governanceDigest: targetGovernanceDigest });
  const target = binder.bind(binding(raw));
  const candidateDigests = ["13900139000", mainlandMobile, "13700137000"].map((candidate) => {
    const governanceDigest = Digest(createHash("sha256").update(candidate, "utf8").digest("hex"));
    assert.throws(
      () => binder.bind({
        ...binding(raw),
        policyBinding: { governanceDigest, harnessDigest }
      } as never),
      /exact|field|binding/iu
    );
    const candidateBinder = createBinder({ governanceDigest });
    const handle = candidateBinder.bind(binding(raw));
    const digest = handle.commitment.policyDigest;
    candidateBinder.release(handle);
    candidateBinder.dispose();
    return digest;
  });

  assert.equal(candidateDigests.includes(target.commitment.policyDigest), false);
  binder.release(target);
  binder.dispose();
});

test("binder snapshots policy data properties at construction and rejects accessors without reading them", () => {
  const mutablePolicy: EffectPolicyBindingV1 = {
    governanceDigest,
    harnessDigest
  };
  const binder = createRuntimeEffectCommitmentBinderV1(mutablePolicy);
  const first = binder.bind(binding({ kind: "text", value: "first" }));
  (mutablePolicy as { governanceDigest: Digest }).governanceDigest = Digest("d".repeat(64));
  (mutablePolicy as { harnessDigest: Digest }).harnessDigest = Digest("e".repeat(64));
  const second = binder.bind(binding({ kind: "text", value: "second" }));

  assert.equal(first.commitment.policyDigest, second.commitment.policyDigest);
  assert.equal(JSON.stringify([first, second]).includes(governanceDigest), false);
  assert.equal(JSON.stringify([first, second]).includes(harnessDigest), false);
  binder.release(first);
  binder.release(second);
  binder.dispose();

  let getterReads = 0;
  const accessorPolicy = Object.defineProperties({}, {
    governanceDigest: {
      enumerable: true,
      get() {
        getterReads += 1;
        return governanceDigest;
      }
    },
    harnessDigest: {
      enumerable: true,
      get() {
        getterReads += 1;
        return harnessDigest;
      }
    }
  });
  assert.throws(
    () => createRuntimeEffectCommitmentBinderV1(accessorPolicy as EffectPolicyBindingV1),
    /data property|accessor/iu
  );
  assert.equal(getterReads, 0);
});

test("control-domain validation stays within a child-process budget near every public length limit", () => {
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const script = `
    const p = await import(${JSON.stringify(moduleUrl)});
    const raw = { kind: "text", value: "ordinary" };
    const segment = "a".repeat(64);
    const identifier = "q".repeat(128);
    const policyBinding = {
      governanceDigest: p.Digest("a".repeat(64)),
      harnessDigest: p.Digest("c".repeat(64))
    };
    const binder = p.createRuntimeEffectCommitmentBinderV1(policyBinding);
    const started = performance.now();
    const handle = binder.bind({
      effectKind: [segment, segment, segment, segment].join("/"),
      sessionId: p.SessionId(identifier),
      runId: p.RunId(identifier),
      candidateId: p.CandidateId(identifier),
      turn: 1,
      step: 1,
      internalEffectId: identifier,
      protectedInput: p.createProtectedTextV1(raw.value),
      raw
    });
    const valid = p.isEffectCommitmentV1(handle.commitment);
    const elapsedMs = performance.now() - started;
    binder.release(handle);
    binder.dispose();
    process.stdout.write(JSON.stringify({ elapsedMs, valid }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 2_000
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const result = JSON.parse(child.stdout) as { elapsedMs: number; valid: boolean };
  assert.equal(result.valid, true);
  assert.ok(result.elapsedMs < 200, `control validation took ${result.elapsedMs.toFixed(1)}ms`);
});

test("text and JSON raw inputs are explicitly distinct while canonical JSON key order remains stable", () => {
  const binder = createBinder();
  const jsonRaw: EffectRawInputV1 = { kind: "json", value: { b: 2, a: "one" } };
  const jsonHandle = binder.bind(binding(jsonRaw));
  assert.equal(binder.verifyAndConsume(jsonHandle, { kind: "json", value: { a: "one", b: 2 } }), true);

  const textRaw: EffectRawInputV1 = { kind: "text", value: "same" };
  const textHandle = binder.bind(binding(textRaw));
  assert.equal(binder.verifyAndConsume(textHandle, { kind: "json", value: "same" }), false);

  const jsonString: EffectRawInputV1 = { kind: "json", value: "same" };
  const jsonStringHandle = binder.bind(binding(jsonString));
  assert.equal(binder.verifyAndConsume(jsonStringHandle, jsonString), true);
  binder.dispose();
});

test("text canonicalization distinguishes isolated UTF-16 surrogates from replacement characters", () => {
  const binder = createBinder();
  const isolatedSurrogate: EffectRawInputV1 = { kind: "text", value: "\ud800" };
  const handle = binder.bind(binding(isolatedSurrogate));
  assert.equal(
    binder.verifyAndConsume(handle, { kind: "text", value: "\ufffd" }),
    false
  );
  binder.dispose();
});

test("binding keeps ordinary structural IDs but rejects protected material instead of markerizing it", () => {
  const binder = createBinder();
  const ordinary = binder.bind(binding());
  assert.equal(ordinary.commitment.sessionId, "session-1");
  binder.release(ordinary);
  const ordinarySuffix = binder.bind(binding(undefined, { candidateId: CandidateId("monkey:x") }));
  assert.equal(ordinarySuffix.commitment.candidateId, "monkey:x");
  binder.release(ordinarySuffix);

  const jwt = [
    "eyJ", "hbGciOiJIUzI1NiJ9", ".",
    "eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".",
    "synthetic_signature"
  ].join("");
  const credentialUri = ["https://", "user", ":", "password", "@example.invalid"].join("");
  const privateKey = [
    "-----BEGIN", " PRIVATE KEY-----\n",
    "synthetic-private-key-material\n",
    "-----END", " PRIVATE KEY-----"
  ].join("");
  for (const [name, value] of [
    ["effectKind", `tool/${rawCredential}`],
    ["sessionId", rawCredential],
    ["runId", jwt],
    ["candidateId", credentialUri],
    ["internalEffectId", privateKey],
    ["sessionId", `session-${mainlandMobile}`],
    ["runId", `run-${prcIdentity}`],
    ["sessionId", `session_${mainlandMobile}`],
    ["runId", `run_${prcIdentity}`],
    ["candidateId", `candidate_${rawCredential}`],
    ["candidateId", `candidate_${awsCredential}_tail`],
    ["candidateId", `candidate_${githubCredential}_tail`],
    ["candidateId", "candidate_token:x"],
    ["internalEffectId", `effecta${mainlandMobile}`]
  ] as const) {
    assert.throws(
      () => binder.bind(binding(undefined, { [name]: value })),
      /protected material/iu,
      name
    );
  }

  for (const [name, value] of [
    ["effectKind", "Shell Tool"],
    ["sessionId", "session/with/slash"],
    ["runId", ""],
    ["candidateId", "candidate with space"],
    ["internalEffectId", "effect\n1"],
    ["turn", 0],
    ["step", Number.MAX_SAFE_INTEGER + 1]
  ] as const) {
    assert.throws(() => binder.bind(binding(undefined, { [name]: value })), /binding|identifier|digest|turn|step/iu, name);
  }
  assert.throws(
    () => binder.bind({ ...binding(), extra: true } as never),
    /exact|field|binding/iu
  );
  assert.throws(
    () => binder.bind(binding({ kind: "text", value: mainlandMobile }, {
      protectedInput: createProtectedTextV1("ordinary")
    })),
    /protectedInput does not match raw/iu
  );
  assert.throws(
    () => binder.bind(binding(undefined, {
      protectedInput: { ...createProtectedTextV1(`api_key=${rawCredential}`), extra: true } as never
    })),
    /exact protected DTO/iu
  );
  assert.throws(
    () => binder.bind({
      ...binding(),
      policyBinding: { governanceDigest: "short", harnessDigest }
    } as never),
    /exact|field|binding/iu
  );
  assert.throws(
    () => createRuntimeEffectCommitmentBinderV1({
      governanceDigest: "short",
      harnessDigest
    } as never),
    /effect policy binding/iu
  );
  binder.dispose();
});

test("raw canonicalization rejects getters, proxies, lossy JSON and resource-limit violations without invoking user code", () => {
  const binder = createBinder();
  let getterReads = 0;
  const rawWithGetter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "never";
    }
  });
  assert.throws(() => binder.bind(binding({ kind: "json", value: rawWithGetter })), /data propert|accessor/iu);
  assert.equal(getterReads, 0);

  let trapCount = 0;
  const proxy = new Proxy({}, {
    ownKeys() {
      trapCount += 1;
      return [];
    }
  });
  assert.throws(() => binder.bind(binding({ kind: "json", value: proxy })), /Proxy/u);
  assert.equal(trapCount, 0);

  for (const value of [undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY, -0, 9_007_199_254_740_992]) {
    assert.throws(() => binder.bind(binding({ kind: "json", value } as never)), /JSON|finite|safe|negative zero/iu);
  }
  assert.throws(
    () => binder.bind(binding({ kind: "text", value: "x".repeat(1_048_577) })),
    /size|limit/iu
  );
  binder.dispose();
});

test("commitment boundaries reject revoked proxies with stable fail-closed errors", () => {
  const binder = createBinder();
  const revokedBinding = Proxy.revocable({}, {});
  revokedBinding.revoke();
  assert.equal(isEffectCommitmentV1(revokedBinding.proxy), false);
  assert.throws(() => assertEffectCommitmentV1(revokedBinding.proxy), /EffectCommitmentV1/u);
  assert.throws(
    () => binder.bind(revokedBinding.proxy as never),
    /effect commitment binding/iu
  );

  const revokedPolicyBinding = Proxy.revocable({}, {});
  revokedPolicyBinding.revoke();
  assert.throws(
    () => createRuntimeEffectCommitmentBinderV1(revokedPolicyBinding.proxy as never),
    /effect policy binding/u
  );

  const revokedRaw = Proxy.revocable({}, {});
  revokedRaw.revoke();
  assert.throws(
    () => binder.bind({ ...binding(), raw: revokedRaw.proxy as never }),
    /effect raw input/iu
  );

  const handle = binder.bind(binding({ kind: "text", value: "ordinary" }));
  assert.equal(binder.verifyAndConsume(handle, revokedRaw.proxy as never), false);
  assert.equal(binder.verifyAndConsume(handle, { kind: "text", value: "ordinary" }), false);
  binder.dispose();
});

test("commitment assertions reject extra fields, truncation and malformed runtime-gate claims", () => {
  const binder = createBinder();
  const handle = binder.bind(binding());
  const valid = handle.commitment;
  assert.equal(isEffectCommitmentV1({ ...valid, raw: "hidden" }), false);
  assert.equal(isEffectCommitmentV1({ ...valid, scope: "durable-audit" }), false);
  assert.equal(isEffectCommitmentV1({ ...valid, keyId: "kid_short" }), false);
  assert.equal(isEffectCommitmentV1({ ...valid, nonce: "short" }), false);
  assert.equal(isEffectCommitmentV1({ ...valid, tag: valid.tag.slice(0, 62) }), false);
  assert.equal(isEffectCommitmentV1({ ...valid, protectedDigest: valid.protectedInputDigest }), false);
  for (const forged of [
    { ...valid, effectKind: `tool/${rawCredential}` },
    { ...valid, sessionId: rawCredential },
    { ...valid, runId: `run-${mainlandMobile}` },
    { ...valid, candidateId: `candidate-${prcIdentity}` },
    { ...valid, sessionId: `session_${mainlandMobile}` },
    { ...valid, runId: `run_${prcIdentity}` },
    { ...valid, candidateId: `candidate_${rawCredential}` },
    { ...valid, candidateId: `candidate_${awsCredential}_tail` },
    { ...valid, candidateId: `candidate_${githubCredential}_tail` },
    { ...valid, candidateId: "candidate_token:x" },
    { ...valid, internalEffectId: `effecta${mainlandMobile}` }
  ]) {
    assert.equal(isEffectCommitmentV1(forged), false);
  }
  assert.throws(() => assertEffectCommitmentV1({ ...valid, algorithm: "SHA-256" }), /EffectCommitmentV1/u);
  assert.throws(() => assertEffectCommitmentV1({ ...valid, sessionId: rawCredential }), /EffectCommitmentV1/u);
  binder.release(handle);
  binder.dispose();
});
