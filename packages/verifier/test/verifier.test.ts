import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateRecord } from "@mn/core";
import { compareCandidates } from "../src/index.js";

test("verifier selects a passing candidate over a blocked candidate", () => {
  const candidates: CandidateRecord[] = [
    {
      id: "bad",
      runId: "r1",
      provider: "claude",
      worktreePath: "/tmp/bad",
      status: "completed",
      gates: [
        {
          gate: "unit_test",
          status: "fail",
          summary: "tests failed",
          evidence: []
        }
      ]
    },
    {
      id: "good",
      runId: "r1",
      provider: "codex",
      worktreePath: "/tmp/good",
      status: "completed",
      gates: [
        {
          gate: "unit_test",
          status: "pass",
          summary: "tests passed",
          evidence: []
        }
      ]
    }
  ];

  assert.equal(compareCandidates(candidates).winnerCandidateId, "good");
});

test("verifier never selects a failed candidate even when gates are non-blocking", () => {
  const failedCandidate: CandidateRecord = {
    id: "failed",
    runId: "r1",
    provider: "claude",
    worktreePath: "/tmp/failed",
    status: "failed",
    result: {
      provider: "claude",
      candidateId: "failed",
      status: "failed",
      exitCode: 1,
      stdout: "model stopped before making a valid change",
      stderr: "",
      summary: "failed without a gate failure",
      artifacts: [],
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString()
    },
    gates: [
      {
        gate: "llm_verifier",
        status: "pass",
        summary: "non-blocking verifier signal",
        evidence: []
      }
    ]
  };

  const comparison = compareCandidates([failedCandidate]);

  assert.equal(comparison.winnerCandidateId, undefined);
  assert.equal(comparison.summary, "No candidate passed blocking gates");
});
