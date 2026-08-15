// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CREDENTIAL_MARKER,
  PHONE_MARKER,
  PRC_ID_MARKER,
  PRIVATE_KEY_MARKER,
  UNSAFE_MARKER,
  containsCredential,
  isCanonicalE164Mobile,
  isMainlandMobile,
  isPrcResidentIdentityNumber,
  protectJsonValue,
  protectText,
  safeErrorMessage,
  type BusinessRedactionOptions,
  type ProtectedJsonValue
} from "../src/index.js";

const mainlandMobile = ["138", "0013", "8000"].join("");
const mainlandE164 = ["+86", mainlandMobile].join("");
const northAmericaE164 = ["+1", "415", "555", "2671"].join("");

function makePrcId(
  address = "110105",
  birthDate = "19900101",
  sequence = "123"
): string {
  const body = `${address}${birthDate}${sequence}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = [...body].reduce((total, digit, index) =>
    total + Number(digit) * (weights[index] ?? 0), 0);
  return `${body}${checks[sum % 11]}`;
}

const prcId = makePrcId();
const sha256Digest = `sha256:${"a".repeat(64)}`;

function credentialFixtures(): Record<string, string> {
  const providerKey = ["sk", "-", "unit", "-", "abcdefghijklmno"].join("");
  const awsKey = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
  const awsTemporaryKey = ["AS", "IA", "ABCDEFGHIJKLMNOP"].join("");
  const githubKey = ["gh", "p_", "abcdefghijklmnopqrstuvwx"].join("");
  const jwt = ["ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjMifQ", ".", "signaturePart"].join("");
  const jwe = ["ey", "JhbGciOiJkaXIifQ", "..", "aXY", ".", "ciphertext", ".", "tagvalue"].join("");
  const pem = [
    "-----BEGIN ",
    "PRIVATE KEY-----\n",
    "synthetic-key-material\n",
    "-----END ",
    "PRIVATE KEY-----"
  ].join("");
  const truncatedPem = [
    "-----BEGIN ",
    "RSA PRIVATE KEY-----\n",
    "synthetic-truncated-material"
  ].join("");
  const pgpPrivateKey = [
    "-----BEGIN PGP ",
    "PRIVATE KEY BLOCK-----\n",
    "synthetic-pgp-material\n",
    "-----END PGP ",
    "PRIVATE KEY BLOCK-----"
  ].join("");
  const truncatedPgpPrivateKey = [
    "-----BEGIN PGP ",
    "PRIVATE KEY BLOCK-----\n",
    "synthetic-truncated-pgp-material"
  ].join("");
  return {
    bearer: `Authorization: Bearer ${providerKey}`,
    basic: `Authorization: Basic ${["dXNl", "cjpwYXNz"].join("")}`,
    jwt,
    jwe,
    pem,
    truncatedPem,
    pgpPrivateKey,
    truncatedPgpPrivateKey,
    uri: `https://${["alice", ":", "synthetic-password", "@"].join("")}example.invalid/path`,
    uriEmptyUser: `https://${[":", "synthetic-password", "@"].join("")}example.invalid/path`,
    longUri: `https://${["alice", ":", "p".repeat(5_000), "@"].join("")}example.invalid/path`,
    longUriUser: `https://${["u".repeat(600), ":", "synthetic-password", "@"].join("")}example.invalid/path`,
    assignment: `client_secret=${["synthetic", "-", "assigned", "-", "value"].join("")}`,
    jsonAssignment: `{"password":"${["synthetic", "-", "json", "-", "value"].join("")}"}`,
    providerKey,
    awsKey,
    awsTemporaryKey,
    githubKey
  };
}

test("exports the standalone data-protection contract", () => {
  const options: BusinessRedactionOptions = { businessRedaction: true };
  assert.equal(protectText("ordinary text", options), "ordinary text");
  assert.equal(typeof protectJsonValue, "function");
  assert.equal(typeof safeErrorMessage, "function");
  assert.equal(typeof containsCredential, "function");
  assert.equal(typeof isMainlandMobile, "function");
  assert.equal(typeof isCanonicalE164Mobile, "function");
  assert.equal(typeof isPrcResidentIdentityNumber, "function");
  assert.deepEqual(
    [CREDENTIAL_MARKER, PHONE_MARKER, PRC_ID_MARKER, PRIVATE_KEY_MARKER, UNSAFE_MARKER],
    [
      "[REDACTED CREDENTIAL]",
      "[REDACTED PHONE]",
      "[REDACTED PRC_ID]",
      "[REDACTED PRIVATE KEY]",
      "[REDACTED UNSAFE JSON]"
    ]
  );

  // @ts-expect-error BusinessRedactionOptions deliberately has no credential bypass.
  const forbidden: BusinessRedactionOptions = { redactCredentials: false };
  assert.deepEqual(forbidden, { redactCredentials: false });

  const protectedContract: ProtectedJsonValue = protectJsonValue({ password: 7 });
  assert.deepEqual(protectedContract, { password: CREDENTIAL_MARKER });
  // @ts-expect-error protection can replace a numeric field with a string marker.
  const unsoundOriginalShape: { password: number } = protectJsonValue({ password: 7 });
  assert.deepEqual(unsoundOriginalShape, { password: CREDENTIAL_MARKER });
});

test("always protects each credential form and reports credential presence", () => {
  for (const [name, fixture] of Object.entries(credentialFixtures())) {
    const output = protectText(fixture, { businessRedaction: false });
    assert.notEqual(output, fixture, `${name} must be protected`);
    assert.equal(output.includes("synthetic-key-material"), false, `${name} leaked material`);
    assert.equal(containsCredential(fixture), true, `${name} must be detected`);
    assert.equal(containsCredential(output), false, `${name} marker must be considered safe`);
    assert.equal(protectText(output, { businessRedaction: false }), output, `${name} must be idempotent`);
  }
});

test("uses distinct credential and private-key markers without a bypass", () => {
  const fixtures = credentialFixtures();
  assert.match(protectText(fixtures.pem ?? ""), new RegExp(PRIVATE_KEY_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
  assert.match(protectText(fixtures.providerKey ?? ""), new RegExp(CREDENTIAL_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
  assert.equal(protectText(fixtures.bearer ?? "", { businessRedaction: false }).includes(fixtures.providerKey ?? ""), false);
});

test("protects sensitive JSON and assignment keys while preserving metadata keys", () => {
  const rawSecret = ["value", "-", "that", "-", "must", "-", "not", "-", "survive"].join("");
  const protectedJson = protectJsonValue({
    password: rawSecret,
    nested: { api_key: rawSecret, sessionToken: rawSecret },
    apiKeyRef: "secret-store/item",
    accessTokenEnv: "MODEL_TOKEN",
    secretDigest: sha256Digest,
    credentialHash: sha256Digest,
    tokenUsage: 19,
    inputTokenCount: 10,
    outputTokenBudget: 20,
    maxTokenLimit: 30,
    credentialConfigured: true,
    secretPresent: false,
    tokens: [1, 2],
    inputTokens: 4,
    outputTokens: 5
  });
  assert.deepEqual(protectedJson, {
    password: CREDENTIAL_MARKER,
    nested: { api_key: CREDENTIAL_MARKER, sessionToken: CREDENTIAL_MARKER },
    apiKeyRef: "secret-store/item",
    accessTokenEnv: "MODEL_TOKEN",
    secretDigest: sha256Digest,
    credentialHash: sha256Digest,
    tokenUsage: 19,
    inputTokenCount: 10,
    outputTokenBudget: 20,
    maxTokenLimit: 30,
    credentialConfigured: true,
    secretPresent: false,
    tokens: CREDENTIAL_MARKER,
    inputTokens: 4,
    outputTokens: 5
  });

  const assignments = [
    `password='${rawSecret}'`,
    `api_key=${rawSecret}`,
    `apiKeyRef=secret-store/item`,
    `inputTokens=19`,
    `tokens=20`
  ].join("\n");
  const output = protectText(assignments, { businessRedaction: false });
  assert.equal(output.includes(rawSecret), false);
  assert.match(output, /apiKeyRef=secret-store\/item/u);
  assert.match(output, /inputTokens=19/u);
  assert.match(output, /tokens=20/u);
});

test("protects semantic credential keys and fails closed on encoded or oversized assignment keys", () => {
  const raw = ["opaque", "-", "credential", "-", "material"].join("");
  const temporaryAwsKey = credentialFixtures().awsTemporaryKey ?? "";
  const input = [
    `aws_access_key_id=${temporaryAwsKey}`,
    `passphrase=${raw}`,
    `pass%25252577ord=${raw}`
  ].join("\n");
  const output = protectText(input, { businessRedaction: false });
  assert.equal(output.includes(temporaryAwsKey), false);
  assert.equal(output.includes(raw), false);

  const oversizedKey = `pass${"\u200B".repeat(260)}word=${raw}`;
  const oversizedOutput = protectText(oversizedKey, { businessRedaction: false });
  assert.equal(oversizedOutput, UNSAFE_MARKER);
  assert.equal(containsCredential(oversizedKey), true);

  const nestedUnicodeKey = `${["\\u005c", "u0070", "assword"].join("")}=${raw}`;
  assert.equal(
    protectText(nestedUnicodeKey, { businessRedaction: false }),
    `${nestedUnicodeKey.slice(0, nestedUnicodeKey.indexOf("=") + 1)}${CREDENTIAL_MARKER}`
  );
  const invalidUnicodeKey = `${["x\\u{", "110000", "}"].join("")}=${raw}`;
  assert.equal(protectText(invalidUnicodeKey, { businessRedaction: false }), UNSAFE_MARKER);

  for (const encodedDelimiter of [
    `password%253D${raw}`,
    `password\\u003d${raw}`,
    `password%EF%BC%9D${raw}`
  ]) {
    assert.equal(protectText(encodedDelimiter, { businessRedaction: false }), UNSAFE_MARKER);
    assert.equal(containsCredential(encodedDelimiter), true);
  }

  const ordinaryLongKey = `${"a".repeat(257)}=ordinary model text`;
  assert.equal(protectText(ordinaryLongKey, { businessRedaction: false }), ordinaryLongKey);
  assert.equal(containsCredential(ordinaryLongKey), false);
});

test("protects authentication-code and session credential equivalents", () => {
  const opaque = ["opaque", "-", "auth", "-", "material"].join("");
  const input = [
    "otp=123456",
    "totp=654321",
    "passcode=112233",
    `authorizationCode=${opaque}`,
    `sessionId=${opaque}`
  ].join("\n");
  const output = protectText(input, { businessRedaction: false });
  assert.equal(output.includes(opaque), false);
  assert.equal(output.includes("123456"), false);
  assert.equal(output.includes("654321"), false);
  assert.equal(output.includes("112233"), false);
  assert.equal(containsCredential(input), true);
});

test("metadata exemptions do not suppress credential-shaped values", () => {
  const providerKey = credentialFixtures().providerKey ?? "";
  const output = protectJsonValue({ apiKeyRef: providerKey, tokens: [providerKey] });
  assert.deepEqual(output, {
    apiKeyRef: CREDENTIAL_MARKER,
    tokens: CREDENTIAL_MARKER
  });
});

test("credential metadata is exempt only for supported value formats and types", () => {
  const opaque = ["opaque", "-", "auth", "-", "material"].join("");
  const unsafeAssignments = [
    `passwordRef=${opaque}`,
    `clientSecretEnv=${opaque}`,
    `secretHash=${opaque}`,
    `credentialDigest=${opaque}`
  ].join("\n");
  const protectedAssignments = protectText(unsafeAssignments, { businessRedaction: false });
  assert.equal(protectedAssignments.includes(opaque), false);
  assert.equal(containsCredential(unsafeAssignments), true);

  const unsafeJson = {
    apiKeyRef: opaque,
    clientSecretEnv: opaque,
    secretHash: opaque,
    credentialDigest: opaque,
    credentialConfigured: "yes",
    tokenUsage: "many"
  };
  assert.deepEqual(protectJsonValue(unsafeJson, { businessRedaction: false }), {
    apiKeyRef: CREDENTIAL_MARKER,
    clientSecretEnv: CREDENTIAL_MARKER,
    secretHash: CREDENTIAL_MARKER,
    credentialDigest: CREDENTIAL_MARKER,
    credentialConfigured: CREDENTIAL_MARKER,
    tokenUsage: CREDENTIAL_MARKER
  });
  const unsafeJsonText = JSON.stringify(unsafeJson);
  assert.equal(protectText(unsafeJsonText, { businessRedaction: false }).includes(opaque), false);
  assert.equal(containsCredential(unsafeJsonText), true);

  const localEncryptedRef = "123e4567-e89b-42d3-a456-426614174000";
  const safeMetadata = {
    apiKeyRef: "secret-store/item",
    passwordRef: localEncryptedRef,
    clientSecretEnv: "MODEL_TOKEN",
    secretHash: sha256Digest,
    credentialDigest: sha256Digest,
    credentialConfigured: true,
    secretPresent: false,
    tokenUsage: 12,
    inputTokenCount: 10
  };
  assert.deepEqual(protectJsonValue(safeMetadata), safeMetadata);
  assert.equal(protectText(JSON.stringify(safeMetadata)), JSON.stringify(safeMetadata));
  assert.equal(containsCredential(JSON.stringify(safeMetadata)), false);
  const safeAssignments = [
    `passwordRef=${localEncryptedRef}`,
    "clientSecretEnv=MODEL_TOKEN",
    `secretHash=${sha256Digest}`,
    "credentialConfigured=true",
    "tokenUsage=12"
  ].join("\n");
  assert.equal(protectText(safeAssignments), safeAssignments);
  assert.equal(containsCredential(safeAssignments), false);

  for (const reference of [
    "env:MODEL_TOKEN",
    "keychain:bW5pdS1zeW50aGV0aWM",
    "mniu:keychain:bW5pdS1zeW50aGV0aWM",
    `local_encrypted:${localEncryptedRef}`,
    `mniu:local_encrypted:${localEncryptedRef}`,
    "secret-store/item"
  ]) {
    assert.deepEqual(protectJsonValue({ passwordRef: reference }), { passwordRef: reference });
  }
});

test("safe markers must occupy the complete assignment value", () => {
  const suffix = ["real", "-", "secret", "-", "value"].join("");
  for (const marker of [CREDENTIAL_MARKER, PRIVATE_KEY_MARKER, UNSAFE_MARKER]) {
    const input = `password=${marker}${suffix}`;
    const output = protectText(input, { businessRedaction: false });
    assert.equal(output.includes(suffix), false);
    assert.equal(containsCredential(input), true);
    assert.equal(containsCredential(output), false);
  }
  assert.equal(
    protectText(`password=${CREDENTIAL_MARKER},next=true`, { businessRedaction: false }),
    `password=${CREDENTIAL_MARKER},next=true`
  );
  for (const separator of [" ", "\t"]) {
    const suffixInput = `password=${CREDENTIAL_MARKER}${separator}${suffix}`;
    assert.equal(protectText(suffixInput, { businessRedaction: false }), `password=${CREDENTIAL_MARKER}`);
    assert.equal(containsCredential(suffixInput), true);
  }

  const bearer = `Bearer ${CREDENTIAL_MARKER}${suffix}`;
  assert.equal(protectText(bearer, { businessRedaction: false }).includes(suffix), false);
  assert.equal(containsCredential(bearer), true);
  const uri = `https://${CREDENTIAL_MARKER}${suffix}@example.invalid`;
  assert.equal(protectText(uri, { businessRedaction: false }).includes(suffix), false);
  assert.equal(containsCredential(uri), true);
});

test("protects plural and qualified credential keys without treating model token metrics as secrets", () => {
  const raw = ["opaque", "-", "credential", "-", "material"].join("");
  assert.deepEqual(protectJsonValue({
    accessTokens: [raw],
    refreshTokens: [raw],
    sessionTokens: [raw],
    apiKeys: [raw],
    credentials: [raw],
    secrets: [raw],
    passwords: [raw],
    passwordConfirmation: raw,
    clientSecretValue: raw,
    tokens: 12,
    inputTokens: 10,
    outputTokens: 2
  }), {
    accessTokens: CREDENTIAL_MARKER,
    refreshTokens: CREDENTIAL_MARKER,
    sessionTokens: CREDENTIAL_MARKER,
    apiKeys: CREDENTIAL_MARKER,
    credentials: CREDENTIAL_MARKER,
    secrets: CREDENTIAL_MARKER,
    passwords: CREDENTIAL_MARKER,
    passwordConfirmation: CREDENTIAL_MARKER,
    clientSecretValue: CREDENTIAL_MARKER,
    tokens: 12,
    inputTokens: 10,
    outputTokens: 2
  });
});

test("allows token metrics only as numeric usage values", () => {
  const opaque = ["opaque", "-", "auth", "-", "material"].join("");
  assert.deepEqual(protectJsonValue({
    tokens: opaque,
    inputTokens: [opaque],
    outputTokens: 2,
    thinkingTokens: 3
  }), {
    tokens: CREDENTIAL_MARKER,
    inputTokens: CREDENTIAL_MARKER,
    outputTokens: 2,
    thinkingTokens: 3
  });
  assert.equal(
    protectText(`tokens=${opaque}\ninputTokens=10`, { businessRedaction: false }),
    `tokens=${CREDENTIAL_MARKER}\ninputTokens=10`
  );
});

test("protects contextual short authorization values without changing ordinary Basic or bearer prose", () => {
  assert.equal(
    protectText("Bearer x", { businessRedaction: false }),
    `Bearer ${CREDENTIAL_MARKER}`
  );
  assert.equal(containsCredential("Bearer x"), true);
  assert.equal(
    protectText(`Basic ${["dT", "pw"].join("")}`, { businessRedaction: false }),
    `Basic ${CREDENTIAL_MARKER}`
  );
  assert.equal(
    protectText("Basic math is ordinary model text", { businessRedaction: false }),
    "Basic math is ordinary model text"
  );
  assert.equal(
    protectText("The bearer token syntax is ordinary model text", { businessRedaction: false }),
    "The bearer token syntax is ordinary model text"
  );
  for (const prose of [
    "Bearer token authentication is standardized",
    "  Bearer token in docs"
  ]) {
    assert.equal(protectText(prose, { businessRedaction: false }), prose);
  }
});

test("recognizes only canonical valid mobile forms", () => {
  assert.equal(isMainlandMobile(mainlandMobile), true);
  assert.equal(isMainlandMobile(mainlandE164), false);
  assert.equal(isMainlandMobile("12800138000"), false);
  assert.equal(isMainlandMobile("01012345678"), false);

  assert.equal(isCanonicalE164Mobile(mainlandE164), true);
  assert.equal(isCanonicalE164Mobile(northAmericaE164), true);
  assert.equal(isCanonicalE164Mobile(mainlandMobile), false);
  assert.equal(isCanonicalE164Mobile("+86138 0013 8000"), false);
  assert.equal(isCanonicalE164Mobile("+0123456789"), false);

  let coerced = false;
  const unknown = new Proxy({}, {
    get(_target, key) {
      if (key === "toString") coerced = true;
      return undefined;
    }
  });
  assert.equal(isMainlandMobile(unknown as never), false);
  assert.equal(isCanonicalE164Mobile(unknown as never), false);
  assert.equal(isPrcResidentIdentityNumber(unknown as never), false);
  assert.equal(coerced, false);
});

test("validates province, calendar date, sequence and MOD11-2 for PRC identity numbers", () => {
  assert.equal(isPrcResidentIdentityNumber(prcId), true);
  assert.equal(isPrcResidentIdentityNumber(`${prcId.slice(0, 17)}${prcId.endsWith("1") ? "2" : "1"}`), false);
  assert.equal(isPrcResidentIdentityNumber(makePrcId("990105")), false);
  assert.equal(isPrcResidentIdentityNumber(makePrcId("110105", "20230229")), false);
  assert.equal(isPrcResidentIdentityNumber(makePrcId("110105", "19900101", "000")), false);
  assert.equal(isPrcResidentIdentityNumber("11010519900101123"), false);
  assert.equal(isPrcResidentIdentityNumber(makePrcId("110000")), false);
  assert.equal(isPrcResidentIdentityNumber(makePrcId("710101")), true);
  assert.equal(isPrcResidentIdentityNumber(makePrcId("810000")), true);
  assert.equal(isPrcResidentIdentityNumber(makePrcId("820000")), true);
  assert.equal(isPrcResidentIdentityNumber(makePrcId("830000")), true);
  assert.equal(isPrcResidentIdentityNumber(makePrcId("810101")), false);
});

test("business protection defaults to only phones and PRC identity numbers", () => {
  const ordinary = [
    "姓名：张三",
    "邮箱：alice@example.com",
    "地址：上海市浦东新区世纪大道 1 号",
    "路径：/Users/alice/work/木牛",
    "用户名：alice_dev",
    "模型文本：thinking and ordinary generated text"
  ].join(" | ");
  const input = `${ordinary} | 手机：${mainlandMobile} | 国际：${northAmericaE164} | 身份证：${prcId}`;
  const output = protectText(input);
  assert.ok(output.includes(ordinary));
  assert.equal(output.includes(mainlandMobile), false);
  assert.equal(output.includes(northAmericaE164), false);
  assert.equal(output.includes(prcId), false);
  assert.match(output, new RegExp(PHONE_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
  assert.match(output, new RegExp(PRC_ID_MARKER.replace(/[\[\]]/gu, "\\$&"), "u"));
});

test("businessRedaction=false disables only phone and identity-number protection", () => {
  const providerKey = credentialFixtures().providerKey ?? "";
  const input = `${mainlandMobile} ${prcId} ${providerKey}`;
  const output = protectText(input, { businessRedaction: false });
  assert.ok(output.includes(mainlandMobile));
  assert.ok(output.includes(prcId));
  assert.equal(output.includes(providerKey), false);
  assert.ok(output.includes(CREDENTIAL_MARKER));
});

test("does not mistake bank cards, long numbers, invalid phones or invalid IDs for business data", () => {
  const card = ["622202", "1234", "567890"].join("");
  const longNumber = ["1234567890", "1234567890", "1234567890"].join("");
  const invalidPhone = "12800138000";
  const invalidId = makePrcId("110105", "20230229");
  const input = `${card} ${longNumber} ${invalidPhone} ${invalidId}`;
  assert.equal(protectText(input), input);
});

test("does not protect phone-shaped substrings embedded in identifiers or words", () => {
  for (const input of [
    `abc${northAmericaE164}xyz`,
    `++${northAmericaE164.slice(1)}`,
    `id_${northAmericaE164}`,
    `abc${mainlandMobile}xyz`,
    `id_${mainlandMobile}`,
    `中文${mainlandMobile}文本`
  ]) {
    assert.equal(protectText(input), input);
  }
  assert.equal(protectText(`(${northAmericaE164})`), `(${PHONE_MARKER})`);
  assert.equal(protectText(`(${mainlandMobile})`), `(${PHONE_MARKER})`);
});

test("protectJsonValue returns a detached lossless snapshot and is idempotent", () => {
  const source = {
    profile: {
      name: "张三",
      email: "alice@example.com",
      phone: mainlandMobile,
      identity: prcId
    },
    values: [null, true, 7, "model text"]
  };
  const first = protectJsonValue(source);
  const firstRecord = first as {
    profile: { name: string; email: string; phone: string; identity: string };
    values: ProtectedJsonValue[];
  };
  assert.notEqual(first, source);
  assert.notEqual(firstRecord.profile, source.profile);
  assert.notEqual(firstRecord.values, source.values);
  assert.deepEqual(first, {
    profile: {
      name: "张三",
      email: "alice@example.com",
      phone: PHONE_MARKER,
      identity: PRC_ID_MARKER
    },
    values: [null, true, 7, "model text"]
  });
  source.profile.name = "mutated";
  source.values[3] = "mutated";
  assert.equal(firstRecord.profile.name, "张三");
  assert.equal(firstRecord.values[3], "model text");
  assert.deepEqual(protectJsonValue(first), first);
});

test("business protection covers numeric JSON phone and identity lexemes", () => {
  assert.deepEqual(protectJsonValue({ phone: Number(mainlandMobile) }), {
    phone: PHONE_MARKER
  });
  assert.deepEqual(
    protectJsonValue({ phone: Number(mainlandMobile) }, { businessRedaction: false }),
    { phone: Number(mainlandMobile) }
  );
  const numericJson = `{"phone":${mainlandMobile},"identity":${prcId}}`;
  assert.equal(
    protectText(numericJson),
    `{"phone":${JSON.stringify(PHONE_MARKER)},"identity":${JSON.stringify(PRC_ID_MARKER)}}`
  );
});

test("protectText keeps complete JSON valid and idempotent", () => {
  const json = `  {"name":"张三","phone":"${mainlandMobile}","identity":"${prcId}"}\n`;
  const first = protectText(json);
  assert.deepEqual(JSON.parse(first), {
    name: "张三",
    phone: PHONE_MARKER,
    identity: PRC_ID_MARKER
  });
  assert.equal(protectText(first), first);
});

test("protectText preserves every non-target JSON byte, duplicate key and large numeric literal", () => {
  const ordinary = '{ "ordinary" : "keep\\u0020me", "n":9007199254740993, "dup":1, "dup":2 }';
  assert.equal(protectText(ordinary), ordinary);

  const withPhone = ` { "name" : "\\u5f20\\u4e09", "email":"alice@example.com", "phone" : "${mainlandMobile}" } `;
  assert.equal(
    protectText(withPhone),
    withPhone.replace(`"${mainlandMobile}"`, JSON.stringify(PHONE_MARKER))
  );

  const raw = ["opaque", "-", "password", "-", "material"].join("");
  const sensitiveObject = `{"ordinary":"keep\\u0020me","password":{"nested":"${raw}"}}`;
  const protectedObject = protectText(sensitiveObject, { businessRedaction: false });
  assert.equal(protectedObject, `{"ordinary":"keep\\u0020me","password":${JSON.stringify(CREDENTIAL_MARKER)}}`);
  assert.equal(protectedObject.includes(raw), false);

  const mixedEscapes = `{"message":"keep\\u0020me slash\\/keep ${mainlandMobile}"}`;
  assert.equal(
    protectText(mixedEscapes),
    mixedEscapes.replace(mainlandMobile, PHONE_MARKER)
  );
});

test("containsCredential reuses JSON-aware credential-only protection", () => {
  const fixtures = [
    '"Bearer x"',
    '{"message":"Bearer x"}',
    `{"message":"password\\u003d${["opaque", "-", "auth"].join("")}"}`
  ];
  for (const fixture of fixtures) {
    const protectedValue = protectText(fixture, { businessRedaction: false });
    assert.notEqual(protectedValue, fixture);
    assert.equal(containsCredential(fixture), true);
    assert.equal(containsCredential(protectedValue), false);
  }
  assert.equal(containsCredential(`{"phone":"${mainlandMobile}"}`), false);
});

test("strict JSON protection rejects unsafe or lossy values without invoking getters", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "message", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must not run";
    }
  });
  assert.throws(() => protectJsonValue(accessor), /data property|accessor|lossless/i);
  assert.equal(getterCalls, 0);

  class CustomValue { readonly value = 1; }
  assert.throws(() => protectJsonValue(new CustomValue()), /plain JSON object|class/i);

  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => protectJsonValue(cycle), /circular|cycle/i);

  const sparse = new Array(2);
  sparse[1] = "value";
  assert.throws(() => protectJsonValue(sparse), /sparse|dense/i);

  const withSymbol = { value: 1, [Symbol("hidden")]: 2 };
  assert.throws(() => protectJsonValue(withSymbol), /symbol/i);

  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
  assert.throws(() => protectJsonValue(dangerous), /unsafe|dangerous|__proto__/i);

  assert.throws(() => protectJsonValue({ value: Number.NaN }), /finite|lossless/i);
  assert.throws(() => protectJsonValue({ value: -0 }), /negative zero|lossless/i);
  assert.throws(() => protectJsonValue({ value: 1n } as never), /bigint|lossless/i);
  assert.throws(() => protectJsonValue({ value: undefined } as never), /undefined|lossless/i);
});

test("rejects Proxy inputs before any reflective trap or Error inspection executes", () => {
  let traps = 0;
  const handler: ProxyHandler<object> = {
    getPrototypeOf() {
      traps += 1;
      return Object.prototype;
    },
    ownKeys() {
      traps += 1;
      return [];
    },
    getOwnPropertyDescriptor() {
      traps += 1;
      return undefined;
    }
  };
  const valueProxy = new Proxy({}, handler);
  assert.throws(() => protectJsonValue(valueProxy), /proxy/i);
  assert.equal(traps, 0);

  const optionsProxy = new Proxy({ businessRedaction: true }, handler) as BusinessRedactionOptions;
  assert.throws(() => protectText("ordinary", optionsProxy), /proxy/i);
  assert.equal(traps, 0);

  const errorProxy = new Proxy(new Error("synthetic failure"), handler);
  assert.equal(safeErrorMessage(errorProxy), "An error could not be inspected safely");
  assert.equal(traps, 0);
});

test("enforces bounded text size, aggregate JSON size and nesting depth", () => {
  assert.equal(protectText("a".repeat(1_048_577)), UNSAFE_MARKER);
  assert.throws(() => protectJsonValue("a".repeat(1_048_577)), /size|limit|large/i);

  let nested: unknown = "leaf";
  for (let index = 0; index < 66; index += 1) nested = { child: nested };
  assert.throws(() => protectJsonValue(nested), /depth|deep|limit/i);
});

test("safeErrorMessage protects strings and own Error messages without coercing unknown values", () => {
  const providerKey = credentialFixtures().providerKey ?? "";
  assert.equal(safeErrorMessage(new Error(`failed for 张三 using ${providerKey}`)), `failed for 张三 using ${CREDENTIAL_MARKER}`);
  assert.equal(safeErrorMessage(`phone ${mainlandMobile}`), `phone ${PHONE_MARKER}`);
  assert.equal(
    safeErrorMessage(`phone ${mainlandMobile} ${providerKey}`, { businessRedaction: false }),
    `phone ${mainlandMobile} ${CREDENTIAL_MARKER}`
  );

  let coerced = false;
  const unknown = {
    toString() {
      coerced = true;
      throw new Error("must not run");
    }
  };
  assert.equal(safeErrorMessage(unknown), "An unknown error occurred");
  assert.equal(coerced, false);

  const errorWithGetter = new Error("temporary");
  delete (errorWithGetter as { message?: string }).message;
  Object.defineProperty(errorWithGetter, "message", {
    get() {
      coerced = true;
      return providerKey;
    }
  });
  assert.equal(safeErrorMessage(errorWithGetter), "An error occurred");
  assert.equal(coerced, false);
});

test("handles adversarial long assignment text without partial credential leakage", () => {
  const secret = ["must", "-", "not", "-", "survive"].join("");
  const input = `${"prefix ".repeat(20_000)}password=${secret}`;
  const output = protectText(input, { businessRedaction: false });
  assert.equal(output.includes(secret), false);
  assert.ok(output.endsWith(CREDENTIAL_MARKER));
});

test("quoted assignment-key parsing stays linear on ambiguous backslashes", () => {
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const script = [
    `import { protectText } from ${JSON.stringify(moduleUrl)};`,
    "const input = String.fromCharCode(32, 34) + String.fromCharCode(92).repeat(40) + 'x';",
    "protectText(input, { businessRedaction: false });",
    "const unit = String.fromCharCode(92) + 'u{x=opaque' + String.fromCharCode(10);",
    "protectText(unit.repeat(70000), { businessRedaction: false });",
    "const provider = ['sk', '-', 'abcdefgh', '|'].join('');",
    "protectText(JSON.stringify({ message: provider.repeat(20000) }), { businessRedaction: false });"
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 1_500
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});
