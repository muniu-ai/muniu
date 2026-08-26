// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpecRevisionV2,
  digestSpecRevisionV2,
  validateSpecRevision,
  validateSpecRevisionV2
} from "../src/index.js";
import type { CreateSpecRevisionV2Input, SpecRevision } from "../src/index.js";

const DIGEST = "a".repeat(64);

function input(overrides: Partial<CreateSpecRevisionV2Input> = {}): CreateSpecRevisionV2Input {
  return {
    specSetId: "customer-commitment-1",
    revision: 1,
    status: "approved",
    domainId: "opc",
    subjectRefs: [{ kind: "customer_commitment", id: "commitment-1", digest: DIGEST }],
    title: "Visit outcome commitment",
    objective: "Produce a customer-confirmed visit record and assigned next actions.",
    outcomes: ["The customer can confirm the visit record."],
    nonGoals: ["Do not send messages before approval."],
    contracts: {
      interface: { entry: "dingtalk" },
      data: { sourceRequired: true },
      state: { terminal: ["completed", "failed", "cancelled"] },
      permission: { externalWrite: "approval_required" },
      exception: { unknownExternalResult: "stop" },
      quality: { sourceTraceRequired: true },
      observability: { evidenceChain: true }
    },
    acceptanceCases: [{
      id: "confirmed-record",
      kind: "positive",
      title: "Confirm visit record",
      given: ["An authorized visit source exists."],
      when: "The salesperson confirms the extracted fields.",
      then: ["Each confirmed field references a source fragment."]
    }],
    risks: [],
    unknowns: [],
    domainExtension: { commitmentId: "commitment-1", price: { currency: "CNY", minorUnits: "10000" } },
    createdAt: "2026-08-26T00:00:00.000Z",
    createdBy: "founder-1",
    approvedAt: "2026-08-26T01:00:00.000Z",
    approvedBy: "founder-1",
    ...overrides
  };
}

test("SpecRevisionV2 creates a domain-neutral immutable approved revision", () => {
  const revision = createSpecRevisionV2(input());
  assert.equal(revision.schemaVersion, 2);
  assert.equal(revision.domainId, "opc");
  assert.equal(revision.digest, digestSpecRevisionV2(revision));
  assert.deepEqual(validateSpecRevisionV2(revision), { valid: true, issues: [] });
  assert.equal(Object.isFrozen(revision), true);
  assert.equal(Object.isFrozen(revision.domainExtension), true);
});

test("SpecRevisionV2 requires coherent approval and predecessor metadata", () => {
  assert.throws(
    () => createSpecRevisionV2(input({ approvedBy: undefined })),
    /approval metadata/u
  );
  assert.throws(
    () => createSpecRevisionV2(input({ revision: 2 })),
    /previousDigest/u
  );
  assert.throws(
    () => createSpecRevisionV2(input({ revision: 1, previousDigest: DIGEST })),
    /previousDigest/u
  );
  assert.throws(
    () => createSpecRevisionV2(input({ status: "draft", approvedBy: undefined })),
    /approval metadata/u
  );
});

test("SpecRevisionV2 closes acceptance, risk, and unknown item schemas", () => {
  assert.throws(
    () => createSpecRevisionV2(input({
      acceptanceCases: [{
        id: "confirmed-record",
        kind: "positive",
        title: "Confirm visit record",
        given: ["An authorized visit source exists."],
        when: "The salesperson confirms the extracted fields.",
        then: ["Each confirmed field references a source fragment."],
        execute: "forbidden"
      } as never]
    })),
    /acceptanceCases/u
  );
  assert.throws(
    () => createSpecRevisionV2(input({ risks: [{ id: "risk-1" } as never] })),
    /risks/u
  );
  assert.throws(
    () => createSpecRevisionV2(input({ unknowns: [{ id: "unknown-1" } as never] })),
    /unknowns/u
  );
});

test("SpecRevisionV2 validation detects tampering without changing V1 validation", () => {
  const revision = createSpecRevisionV2(input());
  const tampered = { ...revision, objective: "Changed after approval." };
  assert.equal(validateSpecRevisionV2(tampered).valid, false);
  assert.ok(validateSpecRevisionV2(tampered).issues.some((issue) => issue.code === "digest_mismatch"));

  const legacy = {
    specSetId: "legacy",
    revision: 1,
    status: "draft",
    source: "native",
    title: "Legacy",
    hypothesis: "Keep V1 valid.",
    outcomes: ["V1 remains readable."],
    nonGoals: ["Do not change V1 semantics."],
    targetServices: [],
    contracts: {
      interface: {}, data: {}, state: {}, permission: {}, exception: {}, quality: {}, observability: {}
    },
    acceptanceCases: [{
      id: "legacy-case",
      kind: "positive",
      title: "Legacy case",
      given: ["A V1 spec exists."],
      when: "It is validated.",
      then: ["It remains valid."]
    }],
    risks: [],
    unknowns: [],
    createdAt: "2026-08-26T00:00:00.000Z",
    createdBy: "author-1"
  } satisfies SpecRevision;
  assert.equal(validateSpecRevision(legacy).valid, true);
});

test("SpecRevisionV2 rejects unknown fields and does not execute accessors", () => {
  assert.throws(
    () => createSpecRevisionV2({ ...input(), execute: "ignored" } as never),
    /not supported/u
  );
  let calls = 0;
  const malicious: Record<string, unknown> = {};
  Object.defineProperty(malicious, "schemaVersion", {
    enumerable: true,
    get() {
      calls += 1;
      return 2;
    }
  });
  assert.equal(validateSpecRevisionV2(malicious).valid, false);
  assert.equal(calls, 0);
});
