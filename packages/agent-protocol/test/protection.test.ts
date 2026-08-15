// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_MARKER,
  PHONE_MARKER,
  PRC_ID_MARKER,
  UNSAFE_MARKER
} from "@mn/data-policy";

import {
  PROTECTION_POLICY_DIGEST_V1,
  assertProtectedJsonViewV1,
  assertProtectedTextV1,
  createProtectedJsonViewV1,
  createProtectedTextV1,
  digestJson,
  isProtectedJsonViewV1,
  isProtectedTextV1,
  type ProtectedJsonNodeV1
} from "../src/index.js";

const mainlandMobile = ["138", "0013", "8000"].join("");
const secondMobile = ["139", "0013", "9000"].join("");
const prcIdentity = ["110105", "19491231", "002", "X"].join("");
const providerCredential = ["sk", "-", "synthetic", "-", "credential", "-", "material"].join("");

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value)
    && Object.values(value as Record<string, unknown>).every((child) => isDeepFrozen(child, seen));
}

function objectEntries(node: ProtectedJsonNodeV1) {
  assert.equal(node.type, "object");
  if (node.type !== "object") throw new Error("expected protected object node");
  return node.entries;
}

function protectedStringValue(node: ProtectedJsonNodeV1 | undefined): string | undefined {
  return node?.type === "string" ? node.value.text : undefined;
}

test("ProtectedTextV1 protects only phone, PRC identity and credentials while retaining ordinary business text", () => {
  const ordinary = [
    "姓名：张三",
    "邮箱：alice@example.com",
    "地址：上海市浦东新区世纪大道 1 号",
    "路径：/Users/alice/work/木牛",
    "用户名：alice_dev",
    "模型文本：ordinary thinking text"
  ].join(" | ");
  const dto = createProtectedTextV1(
    `${ordinary} | 手机：${mainlandMobile} | 身份证：${prcIdentity} | api_key=${providerCredential}`
  );

  assert.equal(dto.schemaVersion, 1);
  assert.equal(dto.kind, "protected-text");
  assert.equal(dto.policyDigest, PROTECTION_POLICY_DIGEST_V1);
  assert.match(dto.text, new RegExp(PHONE_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
  assert.match(dto.text, new RegExp(PRC_ID_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
  assert.match(dto.text, new RegExp(CREDENTIAL_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
  assert.equal(dto.text.includes(mainlandMobile), false);
  assert.equal(dto.text.includes(prcIdentity), false);
  assert.equal(dto.text.includes(providerCredential), false);
  assert.ok(dto.text.includes(ordinary));
  assert.match(dto.digest, /^[0-9a-f]{64}$/u);
  assert.equal(isDeepFrozen(dto), true);
  assert.equal(isProtectedTextV1(dto), true);
  assert.doesNotThrow(() => assertProtectedTextV1(dto));
});

test("ProtectedTextV1 has no business or raw bypass", () => {
  const createWithIgnoredBypass = createProtectedTextV1 as unknown as (
    value: string,
    options: { businessRedaction: false; raw: true }
  ) => ReturnType<typeof createProtectedTextV1>;
  const dto = createWithIgnoredBypass(mainlandMobile, { businessRedaction: false, raw: true });
  assert.equal(dto.text, PHONE_MARKER);
  assert.deepEqual(Object.keys(dto).sort(), ["digest", "kind", "policyDigest", "schemaVersion", "text"]);
  assert.equal(JSON.stringify(dto).includes(mainlandMobile), false);

  const oversized = createProtectedTextV1("x".repeat(1_048_577));
  assert.equal(oversized.text, UNSAFE_MARKER);
});

test("ProtectedJsonViewV1 protects values and user keys without collapsing equal protected keys", () => {
  const source = {
    [mainlandMobile]: { owner: "first" },
    [secondMobile]: { owner: "second" },
    profile: {
      name: "张三",
      email: "alice@example.com",
      address: "上海市浦东新区世纪大道 1 号",
      path: "/Users/alice/work/木牛",
      username: "alice_dev",
      modelText: "ordinary generated text",
      phone: mainlandMobile,
      identity: prcIdentity,
      apiKey: providerCredential
    }
  };

  const view = createProtectedJsonViewV1(source);
  const root = objectEntries(view.root);
  assert.equal(root.length, 3);
  assert.deepEqual(root.slice(0, 2).map((entry) => entry.key.text), [PHONE_MARKER, PHONE_MARKER]);
  assert.deepEqual(root.slice(0, 2).map((entry) => {
    const entries = objectEntries(entry.value);
    const owner = entries[0];
    assert.ok(owner);
    assert.equal(owner.value.type, "string");
    return owner.value.type === "string" ? owner.value.value.text : undefined;
  }), ["first", "second"]);

  const profileEntry = root[2];
  assert.equal(profileEntry?.key.text, "profile");
  assert.ok(profileEntry);
  const profile = new Map(objectEntries(profileEntry.value).map((entry) => [entry.key.text, entry.value]));
  for (const [key, expected] of [
    ["name", "张三"],
    ["email", "alice@example.com"],
    ["address", "上海市浦东新区世纪大道 1 号"],
    ["path", "/Users/alice/work/木牛"],
    ["username", "alice_dev"],
    ["modelText", "ordinary generated text"]
  ] as const) {
    const node = profile.get(key);
    assert.equal(node?.type, "string");
    assert.equal(protectedStringValue(node), expected);
  }
  assert.equal(protectedStringValue(profile.get("phone")), PHONE_MARKER);
  assert.equal(protectedStringValue(profile.get("identity")), PRC_ID_MARKER);
  assert.equal(protectedStringValue(profile.get("apiKey")), CREDENTIAL_MARKER);

  source.profile.name = "mutated";
  assert.equal(protectedStringValue(profile.get("name")), "张三");
  assert.equal(isDeepFrozen(view), true);
  assert.equal(isProtectedJsonViewV1(view), true);
  assert.doesNotThrow(() => assertProtectedJsonViewV1(view));
});

test("protected object entry order and digest are deterministic across source insertion order", () => {
  const first = createProtectedJsonViewV1({ zeta: mainlandMobile, alpha: "ordinary" });
  const second = createProtectedJsonViewV1({ alpha: "ordinary", zeta: mainlandMobile });
  assert.deepEqual(first, second);
  assert.deepEqual(objectEntries(first.root).map((entry) => entry.key.text), ["alpha", "zeta"]);
});

test("protected DTO assertions require exact, internally consistent schemas and fail closed", () => {
  const text = createProtectedTextV1("ordinary");
  assert.equal(isProtectedTextV1({ ...text, raw: "ordinary" }), false);
  assert.equal(isProtectedTextV1({ ...text, text: mainlandMobile }), false);
  assert.equal(isProtectedTextV1({ ...text, digest: "0".repeat(64) }), false);
  assert.throws(() => assertProtectedTextV1({ ...text, extra: true }), /ProtectedTextV1/u);

  const view = createProtectedJsonViewV1({ safe: "ordinary" });
  assert.equal(isProtectedJsonViewV1({ ...view, raw: { safe: "ordinary" } }), false);
  assert.equal(isProtectedJsonViewV1({ ...view, digest: "f".repeat(64) }), false);
  assert.throws(() => assertProtectedJsonViewV1({ ...view, root: { ...view.root, extra: true } }), /ProtectedJsonViewV1/u);

  let proxyTrapCount = 0;
  const proxy = new Proxy({}, {
    ownKeys() {
      proxyTrapCount += 1;
      return [];
    },
    get() {
      proxyTrapCount += 1;
      return undefined;
    }
  });
  assert.equal(isProtectedTextV1(proxy), false);
  assert.equal(isProtectedJsonViewV1(proxy), false);
  assert.equal(proxyTrapCount, 0);
});

test("ProtectedJsonViewV1 predicate rejects a digest-consistent view that bypasses semantic credential-key protection", () => {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "protected-json-view" as const,
    root: {
      type: "object" as const,
      entries: [{
        key: createProtectedTextV1("password"),
        value: { type: "string" as const, value: createProtectedTextV1("opaque-auth-material") }
      }]
    },
    policyDigest: PROTECTION_POLICY_DIGEST_V1
  };
  const forged = { ...envelope, digest: digestJson(envelope) };

  assert.equal(isProtectedJsonViewV1(forged), false);
  assert.throws(() => assertProtectedJsonViewV1(forged), /ProtectedJsonViewV1/u);

  const numericEnvelope = {
    schemaVersion: 1 as const,
    kind: "protected-json-view" as const,
    root: { type: "number" as const, value: Number(mainlandMobile) },
    policyDigest: PROTECTION_POLICY_DIGEST_V1
  };
  assert.equal(isProtectedJsonViewV1({ ...numericEnvelope, digest: digestJson(numericEnvelope) }), false);
});

test("ProtectedJsonViewV1 predicate rejects duplicate and non-canonical ordinary object keys", () => {
  const stringNode = (value: string) => ({
    type: "string" as const,
    value: createProtectedTextV1(value)
  });
  const viewWithEntries = (entries: readonly unknown[]) => {
    const envelope = {
      schemaVersion: 1 as const,
      kind: "protected-json-view" as const,
      root: { type: "object" as const, entries },
      policyDigest: PROTECTION_POLICY_DIGEST_V1
    };
    return { ...envelope, digest: digestJson(envelope) };
  };
  const alpha = { key: createProtectedTextV1("alpha"), value: stringNode("one") };
  const beta = { key: createProtectedTextV1("beta"), value: stringNode("two") };

  assert.equal(isProtectedJsonViewV1(viewWithEntries([alpha, alpha])), false);
  assert.equal(isProtectedJsonViewV1(viewWithEntries([beta, alpha])), false);
  assert.equal(isProtectedJsonViewV1(viewWithEntries([alpha, beta])), true);
});

test("protected DTO predicates fail closed for revoked proxies at every container boundary", () => {
  const revokedTop = Proxy.revocable({}, {});
  revokedTop.revoke();
  assert.equal(isProtectedTextV1(revokedTop.proxy), false);
  assert.equal(isProtectedJsonViewV1(revokedTop.proxy), false);
  assert.throws(() => assertProtectedTextV1(revokedTop.proxy), /ProtectedTextV1/u);
  assert.throws(() => assertProtectedJsonViewV1(revokedTop.proxy), /ProtectedJsonViewV1/u);

  const baseObject = JSON.parse(JSON.stringify(createProtectedJsonViewV1({ safe: "ordinary" }))) as Record<string, unknown>;
  const revokedNode = Proxy.revocable({}, {});
  revokedNode.revoke();
  assert.equal(isProtectedJsonViewV1({ ...baseObject, root: revokedNode.proxy }), false);

  const revokedEntries = Proxy.revocable([], {});
  revokedEntries.revoke();
  assert.equal(isProtectedJsonViewV1({
    ...baseObject,
    root: { type: "object", entries: revokedEntries.proxy }
  }), false);

  const revokedEntry = Proxy.revocable({}, {});
  revokedEntry.revoke();
  assert.equal(isProtectedJsonViewV1({
    ...baseObject,
    root: { type: "object", entries: [revokedEntry.proxy] }
  }), false);

  const revokedItems = Proxy.revocable([], {});
  revokedItems.revoke();
  const nestedArray = {
    ...baseObject,
    root: { type: "array", items: revokedItems.proxy }
  };
  assert.equal(isProtectedJsonViewV1(nestedArray), false);
  assert.throws(() => assertProtectedJsonViewV1(nestedArray), /ProtectedJsonViewV1/u);
});

test("protected JSON creation rejects accessors, proxies, lossy JSON and bounded-resource violations without reading getters", () => {
  let getterReads = 0;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      getterReads += 1;
      return mainlandMobile;
    }
  });
  assert.throws(() => createProtectedJsonViewV1(accessor), /data propert|accessor/iu);
  assert.equal(getterReads, 0);

  let trapCount = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() {
      trapCount += 1;
      return Object.prototype;
    }
  });
  assert.throws(() => createProtectedJsonViewV1(proxy), /Proxy/u);
  assert.equal(trapCount, 0);

  for (const value of [undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY, -0, 9_007_199_254_740_992]) {
    assert.throws(() => createProtectedJsonViewV1(value), /JSON|finite|safe|negative zero/iu);
  }
  const sparse = new Array(2);
  sparse[1] = "value";
  assert.throws(() => createProtectedJsonViewV1(sparse), /dense|sparse/iu);

  let deep: unknown = "leaf";
  for (let index = 0; index < 66; index += 1) deep = [deep];
  assert.throws(() => createProtectedJsonViewV1(deep), /depth|limit/iu);
  assert.throws(() => createProtectedJsonViewV1("x".repeat(1_048_577)), /size|limit/iu);
});

test("protected JSON creation never publishes a view that exceeds its own assertion bounds", () => {
  const markerExpansion = Array.from({ length: 45_000 }, () => "otp=x");
  assert.throws(
    () => createProtectedJsonViewV1(markerExpansion),
    /protected JSON view.*size limit/iu
  );
});
