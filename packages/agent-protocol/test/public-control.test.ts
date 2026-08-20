// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafePublicControlIdV1,
  createSafeDeterministicPublicControlIdV1,
  createSafeRandomPublicControlIdV1,
  isSafePublicControlIdV1
} from "../src/index.js";

const mainlandMobile = ["138", "0013", "8000"].join("");
const prcIdentity = ["110105", "19491231", "002", "X"].join("");
const providerCredential = ["sk", "-", "synthetic", "-", "credential", "-", "material"].join("");

test("public control IDs retain ordinary identifiers and reject embedded protected material", () => {
  for (const value of [
    "session-7f3d8874-13dc-4ee8-b9de-6b604550def4",
    "run:ordinary_1",
    "call.tool-2"
  ]) {
    assert.equal(isSafePublicControlIdV1(value), true);
    assert.doesNotThrow(() => assertSafePublicControlIdV1(value, "test identifier"));
  }

  for (const value of [
    `session_${mainlandMobile}`,
    `run_${prcIdentity}`,
    `call_${providerCredential}_tail`
  ]) {
    assert.equal(isSafePublicControlIdV1(value), false);
    assert.throws(
      () => assertSafePublicControlIdV1(value, "test identifier"),
      (error: unknown) => error instanceof TypeError
        && error.message === "test identifier contains protected material"
        && !error.message.includes(value)
    );
  }
});

test("public control assertions never coerce an untrusted diagnostic label", () => {
  const assertWithUnknownLabel = assertSafePublicControlIdV1 as unknown as (
    value: unknown,
    label: unknown
  ) => void;
  let coercions = 0;
  const hostileLabel = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return "hostile label";
    }
  };
  assert.throws(
    () => assertWithUnknownLabel("invalid identifier", hostileLabel),
    (error: unknown) => error instanceof TypeError
      && error.message === "public control identifier is invalid"
  );
  assert.equal(coercions, 0);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.throws(
    () => assertWithUnknownLabel("invalid identifier", revoked.proxy),
    (error: unknown) => error instanceof TypeError
      && error.message === "public control identifier is invalid"
  );
});

test("random public control IDs use an alphabet that cannot resemble protected numeric material", () => {
  for (let index = 0; index < 1_000; index += 1) {
    const value = createSafeRandomPublicControlIdV1("message");
    assert.match(value, /^message-[wxyz]{64}$/u);
    assert.equal(isSafePublicControlIdV1(value), true);
  }
});

test("deterministic public control IDs cannot resemble protected numeric material", () => {
  const material = JSON.stringify({
    runId: "ec3d06f8-a91c-46f0-a215-859330415eb2",
    candidateId: "builtin-1"
  });
  const value = createSafeDeterministicPublicControlIdV1("agent", material);

  assert.match(value, /^agent-[wxyz]{64}$/u);
  assert.equal(isSafePublicControlIdV1(value), true);
  assert.equal(createSafeDeterministicPublicControlIdV1("agent", material), value);
  assert.notEqual(
    createSafeDeterministicPublicControlIdV1("agent", `${material}-different`),
    value
  );

  const createWithUnknownMaterial = createSafeDeterministicPublicControlIdV1 as unknown as (
    prefix: string,
    material: unknown
  ) => string;
  let coercions = 0;
  assert.throws(
    () => createWithUnknownMaterial("agent", {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return material;
      }
    }),
    (error: unknown) => error instanceof TypeError
      && error.message === "deterministic identifier material is invalid"
  );
  assert.equal(coercions, 0);
  assert.throws(
    () => createSafeDeterministicPublicControlIdV1("agent", "x".repeat(4_097)),
    /deterministic identifier material is invalid/u
  );
});
