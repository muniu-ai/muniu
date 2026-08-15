import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  digestSpecRevision,
  exportSpecKitDirectory,
  importSpecKitDirectory,
  validateSpecRevision
} from "../src/index.js";
import type { SpecRevision } from "../src/index.js";

async function tempRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mn-spec-kit-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  return root;
}

test("Spec Kit import extracts intent and acceptance while preserving source", async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, "customer-health");
  await mkdir(source, { recursive: true });
  const specMarkdown = `# Customer Health\n\n## Goal\nGive managers an explainable daily health signal.\n\n## Success Criteria\n- Managers can filter at-risk customers.\n- Risk reasons are visible.\n\n## Out of Scope\n- Exporting customer data.\n\n## Acceptance Criteria\n- [ ] Empty source data remains unknown.\n\n## Acceptance Scenarios\n### Scenario: Filter at-risk customers\n- Given: The manager owns an at-risk customer.\n- When: The manager filters by risk.\n- Then: The customer is visible.\n\n### Scenario: Reject unauthorized access\n**Kind:** negative\n- Given: The customer has another owner.\n- When: The manager opens the details.\n- Then: The request is rejected with 403.\n`;
  const planMarkdown = "# Plan\n\nUse the customer-api as the data owner.\n";
  const tasksMarkdown = "# Tasks\n\n- [ ] Add contract tests.\n";
  await writeFile(path.join(source, "spec.md"), specMarkdown, "utf8");
  await writeFile(path.join(source, "plan.md"), planMarkdown, "utf8");
  await writeFile(path.join(source, "tasks.md"), tasksMarkdown, "utf8");

  const revision = await importSpecKitDirectory(source, {
    specSetId: "customer-health",
    targetServices: ["customer-api", "customer-web"],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "architect@example.com"
  });

  assert.equal(revision.title, "Customer Health");
  assert.equal(
    revision.hypothesis,
    "Give managers an explainable daily health signal."
  );
  assert.deepEqual(revision.outcomes, [
    "Managers can filter at-risk customers.",
    "Risk reasons are visible."
  ]);
  assert.deepEqual(revision.nonGoals, ["Exporting customer data."]);
  assert.deepEqual(
    revision.acceptanceCases.map((acceptance) => acceptance.kind),
    ["boundary", "positive", "negative"]
  );
  const metadata = revision.contracts.metadata as {
    specKit: { specMd: string; planMd?: string; tasksMd?: string };
  };
  assert.equal(metadata.specKit.specMd, specMarkdown);
  assert.equal(metadata.specKit.planMd, planMarkdown);
  assert.equal(metadata.specKit.tasksMd, tasksMarkdown);
  assert.equal(validateSpecRevision(revision).valid, true);
});

test("Spec Kit export is deterministic and can be imported again", async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "spec.md"),
    `# Billing Change\n\n## Goal\nMake billing retries explicit.\n\n## Success Criteria\n- Failed payments have a retry state.\n\n## Out of Scope\n- Changing payment providers.\n\n## Acceptance Criteria\n- [ ] Duplicate callbacks remain idempotent.\n`,
    "utf8"
  );
  const revision = await importSpecKitDirectory(source, {
    specSetId: "billing-change",
    targetServices: ["billing-api"],
    createdAt: "2026-07-11T00:00:00.000Z"
  });

  await exportSpecKitDirectory(output, revision);
  const first = await Promise.all(
    ["spec.md", "plan.md", "tasks.md"].map((name) =>
      readFile(path.join(output, name), "utf8")
    )
  );
  await exportSpecKitDirectory(output, revision);
  const second = await Promise.all(
    ["spec.md", "plan.md", "tasks.md"].map((name) =>
      readFile(path.join(output, name), "utf8")
    )
  );

  assert.deepEqual(second, first);
  assert.match(first[0]!, /^# Billing Change/mu);
  assert.match(first[1]!, /^# Implementation Plan: Billing Change/mu);
  assert.match(first[2]!, /^# Tasks: Billing Change/mu);

  const roundTripped = await importSpecKitDirectory(output, {
    specSetId: "billing-change-round-trip",
    createdAt: "2026-07-12T00:00:00.000Z"
  });
  assert.equal(roundTripped.title, revision.title);
  assert.deepEqual(roundTripped.outcomes, revision.outcomes);
  assert.deepEqual(roundTripped.nonGoals, revision.nonGoals);
  assert.deepEqual(roundTripped.targetServices, revision.targetServices);
  assert.deepEqual(roundTripped.contracts, revision.contracts);
  assert.deepEqual(roundTripped.risks, revision.risks);
  assert.deepEqual(roundTripped.unknowns, revision.unknowns);
  assert.deepEqual(
    roundTripped.acceptanceCases.map(({ id, targetService }) => ({
      id,
      targetService
    })),
    revision.acceptanceCases.map(({ id, targetService }) => ({
      id,
      targetService
    }))
  );
  assert.deepEqual(
    roundTripped.acceptanceCases.map((acceptance) => acceptance.kind),
    revision.acceptanceCases.map((acceptance) => acceptance.kind)
  );
});

test("Spec Kit interop preserves whitespace-sensitive machine semantics", async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, "source-whitespace");
  const output = path.join(root, "output-whitespace");
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "spec.md"),
    "# Exact Text\n\n## Goal\nInitial goal.\n\n## Success Criteria\n- Initial outcome.\n\n## Out of Scope\n- Initial non-goal.\n\n## Acceptance Criteria\n- [ ] Initial acceptance.\n",
    "utf8"
  );
  const imported = await importSpecKitDirectory(source, {
    specSetId: "exact-text",
    createdAt: "2026-07-11T00:00:00.000Z"
  });
  const { digest: _digest, ...base } = imported;
  const unsigned: Omit<SpecRevision, "digest"> = {
    ...base,
    title: "Exact   Text\nTitle",
    hypothesis: "Line one\nLine   two",
    outcomes: ["Outcome   exact"],
    nonGoals: ["Not\nthis   thing"],
    acceptanceCases: [
      {
        ...imported.acceptanceCases[0]!,
        id: "legacy-acceptance-1",
        title: "Keep   exact\nscenario",
        given: ["Given   exact\nstate"],
        when: "When   exact\naction",
        then: ["Then   exact\nresult"]
      }
    ]
  };
  const revision: SpecRevision = {
    ...unsigned,
    digest: digestSpecRevision(unsigned)
  };

  await exportSpecKitDirectory(output, revision);
  const roundTripped = await importSpecKitDirectory(output, {
    specSetId: "exact-text-round-trip",
    createdAt: "2026-07-12T00:00:00.000Z"
  });
  assert.equal(roundTripped.title, revision.title);
  assert.equal(roundTripped.hypothesis, revision.hypothesis);
  assert.deepEqual(roundTripped.outcomes, revision.outcomes);
  assert.deepEqual(roundTripped.nonGoals, revision.nonGoals);
  assert.deepEqual(roundTripped.acceptanceCases, revision.acceptanceCases);
});

test("Spec Kit interop rejects unknown mandatory metadata", async (t) => {
  const root = await tempRoot(t);
  const output = path.join(root, "output-unknown-metadata");
  await exportSpecKitDirectory(output, (await importSpecKitDirectory(
    await (async () => {
      const source = path.join(root, "source-unknown-metadata");
      await mkdir(source, { recursive: true });
      await writeFile(
        path.join(source, "spec.md"),
        "# Exact\n\n## Goal\nKeep semantics.\n\n## Success Criteria\n- It works.\n\n## Out of Scope\n- None.\n\n## Acceptance Criteria\n- [ ] It works.\n",
        "utf8"
      );
      return source;
    })(),
    { specSetId: "unknown-metadata", createdAt: "2026-07-11T00:00:00.000Z" }
  )));
  const planPath = path.join(output, "plan.md");
  const plan = await readFile(planPath, "utf8");
  await writeFile(
    planPath,
    plan.replace('"acceptanceCases":', '"complianceRequirement": "MUST retain this",\n  "acceptanceCases":'),
    "utf8"
  );

  await assert.rejects(
    importSpecKitDirectory(output, {
      specSetId: "unknown-metadata-roundtrip",
      createdAt: "2026-07-12T00:00:00.000Z"
    }),
    /invalid shape/u
  );
});

test("Spec Kit interop rejects malformed or duplicate metadata sections", async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, "source-metadata-shape");
  const output = path.join(root, "output-metadata-shape");
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "spec.md"),
    "# Metadata\n\n## Goal\nKeep all machine semantics.\n\n## Success Criteria\n- It works.\n\n## Out of Scope\n- None.\n\n## Acceptance Criteria\n- [ ] It works.\n",
    "utf8"
  );
  const revision = await importSpecKitDirectory(source, {
    specSetId: "metadata-shape",
    createdAt: "2026-07-11T00:00:00.000Z"
  });
  await exportSpecKitDirectory(output, revision);
  const planPath = path.join(output, "plan.md");
  const original = await readFile(planPath, "utf8");
  await writeFile(
    planPath,
    original.replace(
      /(## MN Interop Metadata[\s\S]*?)(`{3,})json/u,
      "$1$2javascript"
    ),
    "utf8"
  );
  await assert.rejects(
    importSpecKitDirectory(output, {
      specSetId: "metadata-malformed",
      createdAt: "2026-07-12T00:00:00.000Z"
    }),
    /requires a closed JSON fence/u
  );

  await writeFile(
    planPath,
    `${original}\n## MN Interop Metadata\n\n\`\`\`json\n{"compliance":"must-not-ignore"}\n\`\`\`\n`,
    "utf8"
  );
  await assert.rejects(
    importSpecKitDirectory(output, {
      specSetId: "metadata-duplicate",
      createdAt: "2026-07-12T00:00:00.000Z"
    }),
    /at most one MN Interop Metadata/u
  );
});

test("Spec Kit interop fails closed when human-edited spec drifts from metadata", async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, "source-drift");
  const output = path.join(root, "output-drift");
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "spec.md"),
    "# Security\n\n## Goal\nOld goal.\n\n## Success Criteria\n- It works.\n\n## Out of Scope\n- None.\n\n## Acceptance Criteria\n- [ ] It works.\n",
    "utf8"
  );
  const revision = await importSpecKitDirectory(source, {
    specSetId: "spec-drift",
    createdAt: "2026-07-11T00:00:00.000Z"
  });
  await exportSpecKitDirectory(output, revision);
  const specPath = path.join(output, "spec.md");
  const spec = await readFile(specPath, "utf8");
  await writeFile(specPath, spec.replace("Old goal.", "New security goal."), "utf8");

  await assert.rejects(
    importSpecKitDirectory(output, {
      specSetId: "spec-drift-roundtrip",
      createdAt: "2026-07-12T00:00:00.000Z"
    }),
    /drifted from MN Interop Metadata/u
  );
});

test("Spec Kit interop round-trips machine text containing Markdown fences", async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, "source-fence");
  const output = path.join(root, "output-fence");
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "spec.md"),
    "# Fences\n\n## Goal\nInitial goal.\n\n## Success Criteria\n- It works.\n\n## Out of Scope\n- None.\n\n## Acceptance Criteria\n- [ ] It works.\n",
    "utf8"
  );
  const imported = await importSpecKitDirectory(source, {
    specSetId: "fence-source",
    createdAt: "2026-07-11T00:00:00.000Z"
  });
  const { digest: _digest, ...base } = imported;
  const unsigned: Omit<SpecRevision, "digest"> = {
    ...base,
    hypothesis: "Use ```json fenced examples."
  };
  const revision: SpecRevision = {
    ...unsigned,
    digest: digestSpecRevision(unsigned)
  };
  await exportSpecKitDirectory(output, revision);

  const roundTripped = await importSpecKitDirectory(output, {
    specSetId: "fence-roundtrip",
    createdAt: "2026-07-12T00:00:00.000Z"
  });
  assert.equal(roundTripped.hypothesis, revision.hypothesis);
  assert.match(await readFile(path.join(output, "plan.md"), "utf8"), /````json/u);
});

test("Spec Kit interop uses one display projection for Markdown emphasis", async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, "source-emphasis");
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "spec.md"),
    "# Emphasis\n\n## Goal\nInitial goal.\n\n## Success Criteria\n- It works.\n\n## Out of Scope\n- None.\n\n## Acceptance Criteria\n- [ ] It works.\n",
    "utf8"
  );
  const imported = await importSpecKitDirectory(source, {
    specSetId: "emphasis-source",
    createdAt: "2026-07-11T00:00:00.000Z"
  });

  for (const [index, hypothesis] of [
    "Use **literal emphasis** safely.",
    "Use __underscored__ safely.",
    "Use *asterisks* safely."
  ].entries()) {
    const { digest: _digest, ...base } = imported;
    const unsigned: Omit<SpecRevision, "digest"> = { ...base, hypothesis };
    const revision: SpecRevision = {
      ...unsigned,
      digest: digestSpecRevision(unsigned)
    };
    const output = path.join(root, `output-emphasis-${index}`);
    await exportSpecKitDirectory(output, revision);
    const roundTripped = await importSpecKitDirectory(output, {
      specSetId: `emphasis-roundtrip-${index}`,
      createdAt: "2026-07-12T00:00:00.000Z"
    });
    assert.equal(roundTripped.hypothesis, hypothesis);
  }
});

test("Spec Kit import fails when spec.md is missing", async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(
    importSpecKitDirectory(root, {
      specSetId: "missing-spec",
      createdAt: "2026-07-11T00:00:00.000Z"
    }),
    /Spec Kit directory must contain spec.md/u
  );
});

test("Spec Kit import understands mandatory template headings and inline scenarios", async (t) => {
  const root = await tempRoot(t);
  await writeFile(
    path.join(root, "spec.md"),
    `# Feature Specification: Billing Retry\n\n**Feature Branch**: \`001-billing-retry\`\n**Input**: User description: "Make failed payment retries explicit."\n\n## User Scenarios & Testing *(mandatory)*\n\n### User Story 1 - Retry a failed payment\n\nAn operator retries a failed payment.\n\n#### Acceptance Scenarios\n\n1. **Given** a failed payment, **When** the operator retries it, **Then** the payment enters retrying state.\n\n### Edge Cases\n\n- Duplicate callbacks remain idempotent.\n\n## Success Criteria *(mandatory)*\n\n### Measurable Outcomes\n\n- **SC-001**: Operators can identify the retry state.\n`,
    "utf8"
  );

  const revision = await importSpecKitDirectory(root, {
    specSetId: "billing-retry",
    createdAt: "2026-07-11T00:00:00.000Z"
  });

  assert.equal(
    revision.hypothesis,
    "Make failed payment retries explicit."
  );
  assert.deepEqual(revision.outcomes, [
    "SC-001: Operators can identify the retry state."
  ]);
  assert.deepEqual(
    revision.acceptanceCases.map((acceptance) => acceptance.kind),
    ["positive", "boundary"]
  );
  assert.match(revision.acceptanceCases[0]!.when, /operator retries it/iu);
});
