import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FileSpecRepository,
  createLegacySpecRevision,
  createNextSpecRevision,
  digestSpecRevision
} from "../src/index.js";
import type { SpecRevision } from "../src/index.js";
import { makeRevision, makeSpecSet } from "./fixtures.js";

async function tempRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mn-spec-repository-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  return root;
}

test("file repository creates, gets, and deterministically lists spec sets", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  const revision = makeRevision();

  await repository.create(makeSpecSet(), revision);
  await repository.create(makeSpecSet("billing-change"));

  const stored = await repository.get("customer-health");
  assert.equal(stored?.specSet.latestRevision, 1);
  assert.deepEqual(stored?.revisions, [revision]);
  assert.deepEqual(
    (await repository.list()).map((specSet) => specSet.id),
    ["billing-change", "customer-health"]
  );
  assert.equal(await repository.get("missing-spec"), undefined);

  const storagePath = path.join(
    root,
    "specs",
    "customer-health",
    "spec.yaml"
  );
  const content = await readFile(storagePath, "utf8");
  assert.match(content, /"kind": "SpecSet"/u);
  assert.ok(content.endsWith("\n"));
  assert.deepEqual(
    (await readdir(path.dirname(storagePath))).filter((name) => name.includes(".tmp")),
    []
  );
});

test("repository materializes deeply immutable records", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  const created = await repository.create(makeSpecSet(), makeRevision());
  const loaded = await repository.get("customer-health");
  for (const record of [created, loaded!]) {
    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(record.specSet), true);
    assert.equal(Object.isFrozen(record.revisions), true);
    assert.equal(Object.isFrozen(record.revisions[0]), true);
    assert.equal(Object.isFrozen(record.revisions[0]!.contracts), true);
    assert.throws(() => {
      (record.revisions[0] as { hypothesis: string }).hypothesis = "tampered";
    }, TypeError);
  }
});

test("saveRevision is append-only, idempotent by digest, and rejects conflicts", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  const first = makeRevision();
  await repository.create(makeSpecSet(), first);

  const second = createNextSpecRevision(first, {
    outcomes: [...first.outcomes, "Risk reasons are visible."],
    createdAt: "2026-07-12T00:00:00.000Z"
  });
  await repository.saveRevision(second);
  await repository.saveRevision(second);

  const stored = await repository.get(first.specSetId);
  assert.deepEqual(
    stored?.revisions.map((revision) => revision.revision),
    [1, 2]
  );

  const conflictingUnsigned: SpecRevision = {
    ...second,
    hypothesis: "This content conflicts with the persisted revision.",
    digest: undefined
  };
  const conflicting: SpecRevision = {
    ...conflictingUnsigned,
    digest: digestSpecRevision(conflictingUnsigned)
  };
  await assert.rejects(
    repository.saveRevision(conflicting),
    /Revision 2 already exists with a different digest/u
  );

  const third = createNextSpecRevision(second, {
    createdAt: "2026-07-13T00:00:00.000Z"
  });
  const fourth = createNextSpecRevision(third, {
    createdAt: "2026-07-14T00:00:00.000Z"
  });
  await assert.rejects(
    repository.saveRevision(fourth),
    /Expected revision 3 but received 4/u
  );
});

test("repository rejects a revision timestamp earlier than its predecessor", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  const first = makeRevision({
    specSetId: "timeline",
    createdAt: "2026-07-11T00:00:00.000Z"
  });
  await repository.create(makeSpecSet("timeline"), first);
  const { digest: _digest, ...firstUnsigned } = first;
  const regressingUnsigned = {
    ...firstUnsigned,
    revision: 2,
    createdAt: "2026-07-10T00:00:00.000Z"
  };
  const regressing = {
    ...regressingUnsigned,
    digest: digestSpecRevision(regressingUnsigned)
  };

  await assert.rejects(
    repository.saveRevision(regressing),
    /at or after the predecessor event floor/u
  );
});

test("repository rejects an initial revision before creating invalid storage", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  await assert.rejects(
    repository.create(
      {
        ...makeSpecSet("initial-timeline"),
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z"
      },
      makeRevision({
        specSetId: "initial-timeline",
        createdAt: "2026-07-11T00:00:00.000Z"
      })
    ),
    /at or after the spec set createdAt/u
  );
  assert.equal(await repository.get("initial-timeline"), undefined);
});

test("repository rejects traversal identifiers before filesystem access", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);

  await assert.rejects(
    repository.create(makeSpecSet("../outside")),
    /repository-safe identifier|Unsafe spec set id/u
  );
  await assert.rejects(repository.get(".."), /Unsafe spec set id/u);
  await assert.rejects(
    repository.saveRevision(makeRevision({ specSetId: "nested/spec" })),
    /repository-safe identifier|Unsafe spec set id/u
  );

  await assert.rejects(readFile(path.join(root, "outside", "spec.yaml"), "utf8"));
});

test("repository reads legacy JSON but always prefers native YAML", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  await repository.create(makeSpecSet(), makeRevision());
  const directory = path.join(root, "specs", "customer-health");
  const yamlPath = path.join(directory, "spec.yaml");
  const jsonPath = path.join(directory, "spec.json");

  await rename(yamlPath, jsonPath);
  assert.equal((await repository.get("customer-health"))?.revisions.length, 1);

  await copyFile(jsonPath, yamlPath);
  await writeFile(jsonPath, "corrupt fallback that must not be read", "utf8");
  assert.equal((await repository.get("customer-health"))?.revisions.length, 1);
});

test("repository rejects symlink escapes even when the identifier is safe", async (t) => {
  const root = await tempRoot(t);
  const externalRoot = await tempRoot(t);
  const externalRepository = new FileSpecRepository(externalRoot);
  await externalRepository.create(makeSpecSet(), makeRevision());
  await mkdir(path.join(root, "specs"), { recursive: true });
  await symlink(
    path.join(externalRoot, "specs", "customer-health"),
    path.join(root, "specs", "customer-health")
  );

  const repository = new FileSpecRepository(root);
  await assert.rejects(
    repository.get("customer-health"),
    /Symbolic links are not allowed/u
  );
});

test("repository rejects a symlinked specs root before creating data", async (t) => {
  const root = await tempRoot(t);
  const externalRoot = await tempRoot(t);
  await symlink(externalRoot, path.join(root, "specs"));

  const repository = new FileSpecRepository(root);
  await assert.rejects(
    repository.create(makeSpecSet(), makeRevision()),
    /Symbolic links are not allowed/u
  );
  await assert.rejects(
    readFile(path.join(externalRoot, "customer-health", "spec.yaml"), "utf8")
  );
});

test("repository rejects a configured root that is itself a symlink", async (t) => {
  const parent = await tempRoot(t);
  const externalRoot = await tempRoot(t);
  const linkedRoot = path.join(parent, "repository-link");
  await symlink(externalRoot, linkedRoot);

  const repository = new FileSpecRepository(linkedRoot);
  await assert.rejects(
    repository.create(makeSpecSet(), makeRevision()),
    /repository root/u
  );
  await assert.rejects(
    readFile(path.join(externalRoot, "specs", "customer-health", "spec.yaml"), "utf8")
  );
});

test("repository validates SpecSet ingress without executing accessors", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  let calls = 0;
  const malicious = { ...makeSpecSet() } as Record<string, unknown>;
  Object.defineProperty(malicious, "id", {
    enumerable: true,
    get() {
      calls += 1;
      return "getter-spec";
    }
  });
  await assert.rejects(
    repository.create(malicious as unknown as ReturnType<typeof makeSpecSet>),
    /canonical declarative JSON/u
  );
  assert.equal(calls, 0);
});

test("repository rejects invalid optional metadata before writing", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  await assert.rejects(
    repository.create({
      ...makeSpecSet("invalid-description"),
      description: 42
    } as never),
    /description must be a string/u
  );
  await assert.rejects(
    readFile(path.join(root, "specs", "invalid-description", "spec.yaml"), "utf8")
  );
});

test("repository rejects persisted revisions without identity digests", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  await repository.create(makeSpecSet(), makeRevision());
  const storagePath = path.join(
    root,
    "specs",
    "customer-health",
    "spec.yaml"
  );
  const document = JSON.parse(await readFile(storagePath, "utf8")) as {
    revisions: Array<{ digest?: string }>;
  };
  delete document.revisions[0]!.digest;
  await writeFile(storagePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  await assert.rejects(
    repository.get("customer-health"),
    /Persisted spec revision must include a digest/u
  );
});

test("repository rejects a document stored under a different safe identifier", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  await repository.create(makeSpecSet(), makeRevision());
  const sourcePath = path.join(
    root,
    "specs",
    "customer-health",
    "spec.yaml"
  );
  const aliasDirectory = path.join(root, "specs", "safe-alias");
  await mkdir(aliasDirectory);
  await copyFile(sourcePath, path.join(aliasDirectory, "spec.yaml"));

  await assert.rejects(
    repository.get("safe-alias"),
    /does not match storage id safe-alias/u
  );
});

test("repository persists an automatically wrapped legacy task", async (t) => {
  const root = await tempRoot(t);
  const repository = new FileSpecRepository(root);
  const revision = createLegacySpecRevision({
    taskId: "legacy-task-1",
    prompt: "Preserve classic execution.",
    acceptanceCriteria: ["The revision is append-only."],
    createdAt: "2026-07-11T00:00:00.000Z"
  });
  await repository.create(
    {
      id: revision.specSetId,
      title: revision.title,
      latestRevision: 0,
      createdAt: revision.createdAt,
      updatedAt: revision.createdAt
    },
    revision
  );
  assert.equal(
    (await repository.get(revision.specSetId))?.revisions[0]?.digest,
    revision.digest
  );
});

test("separate repository instances serialize concurrent append-only writes", async (t) => {
  const root = await tempRoot(t);
  const firstRepository = new FileSpecRepository(root);
  const secondRepository = new FileSpecRepository(root);
  const first = makeRevision();
  await firstRepository.create(makeSpecSet(), first);
  const secondA = createNextSpecRevision(first, {
    hypothesis: "Concurrent writer A",
    createdAt: "2026-07-12T00:00:00.000Z"
  });
  const secondB = createNextSpecRevision(first, {
    hypothesis: "Concurrent writer B",
    createdAt: "2026-07-12T00:00:00.000Z"
  });

  const results = await Promise.allSettled([
    firstRepository.saveRevision(secondA),
    secondRepository.saveRevision(secondB)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const stored = await firstRepository.get(first.specSetId);
  assert.equal(stored?.revisions.length, 2);
  assert.ok(
    stored?.revisions[1]?.digest === secondA.digest ||
      stored?.revisions[1]?.digest === secondB.digest
  );
});

test("repository atomically restores a complete durable revision history", async (t) => {
  const root = await tempRoot(t);
  const source = new FileSpecRepository(path.join(root, "source"));
  const target = new FileSpecRepository(path.join(root, "target"));
  const first = makeRevision();
  await source.create(makeSpecSet(), first);
  const second = createNextSpecRevision(first, {
    outcomes: [...first.outcomes, "Restarted APIs retain the whole history."],
    createdAt: "2026-07-12T00:00:00.000Z"
  });
  await source.saveRevision(second);
  const durable = (await source.get(first.specSetId))!;

  await target.restore(durable);
  assert.deepEqual(await target.get(first.specSetId), durable);

  const divergentRoot = new FileSpecRepository(path.join(root, "divergent"));
  const divergent = makeRevision({ hypothesis: "Divergent local cache" });
  await divergentRoot.create(makeSpecSet(), divergent);
  await assert.rejects(
    divergentRoot.restore(durable, { overwrite: false }),
    /different content/u
  );
  await divergentRoot.restore(durable);
  assert.deepEqual(await divergentRoot.get(first.specSetId), durable);
});
