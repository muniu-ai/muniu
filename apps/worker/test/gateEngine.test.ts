import { mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateEngine } from "../src/index.js";

test("npm gates pass when the matching script exits zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-gate-pass-"));
  await writePackageJson(root, {
    scripts: {
      test: "node -e \"console.log('tests ok')\"",
      typecheck: "node -e \"console.log('types ok')\""
    }
  });

  const gates = await runGateEngine({
    cwd: root,
    requiredGates: ["unit_test", "typecheck"],
    stdout: "",
    stderr: ""
  });

  assert.deepEqual(
    gates.map((gate) => [gate.gate, gate.status]),
    [
      ["unit_test", "pass"],
      ["typecheck", "pass"]
    ]
  );
  await rm(root, { recursive: true, force: true });
});

test("npm gates fail when the matching script exits non-zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-gate-fail-"));
  await writePackageJson(root, {
    scripts: {
      lint: "node -e \"process.exit(7)\""
    }
  });

  const gates = await runGateEngine({
    cwd: root,
    requiredGates: ["lint"],
    stdout: "",
    stderr: ""
  });

  assert.equal(gates[0]?.gate, "lint");
  assert.equal(gates[0]?.status, "fail");
  assert.match(gates[0]?.summary ?? "", /failed with exit code/);
  await rm(root, { recursive: true, force: true });
});

test("npm gates skip when package.json lacks the matching script", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-gate-skip-"));
  await writePackageJson(root, { scripts: { test: "node -e \"true\"" } });

  const gates = await runGateEngine({
    cwd: root,
    requiredGates: ["typecheck"],
    stdout: "",
    stderr: ""
  });

  assert.equal(gates[0]?.gate, "typecheck");
  assert.equal(gates[0]?.status, "skipped");
  assert.match(gates[0]?.summary ?? "", /No npm script/);
  await rm(root, { recursive: true, force: true });
});

async function writePackageJson(root: string, body: unknown): Promise<void> {
  await writeFile(join(root, "package.json"), `${JSON.stringify(body)}\n`);
}
