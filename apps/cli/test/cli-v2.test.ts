import assert from "node:assert/strict";
import test from "node:test";
import { runCli, type CliIo } from "../src/index.js";

function io(): CliIo & { out: string[]; err: string[] } {
  const value = {
    out: [] as string[], err: [] as string[],
    stdout(line: string) { value.out.push(line); },
    stderr(line: string) { value.err.push(line); },
  };
  return value;
}

test("帮助只暴露 0.2 命令", async () => {
  const output = io();
  assert.equal(await runCli(["--help"], { io: output }), 0);
  const help = output.out.join("\n");
  for (const command of ["setup", "ask", "inbox", "resume", "doctor", "plugin", "opc", "code", "backup"]) {
    assert.match(help, new RegExp(`^  ${command}(?: |$)`, "m"));
  }
  for (const removed of ["run", "provider", "profile", "project", "task", "spec", "config"]) {
    assert.doesNotMatch(help, new RegExp(`^  ${removed}(?: |$)`, "m"));
  }
});

test("--json 输出固定 envelope", async () => {
  const output = io();
  const fetch: typeof globalThis.fetch = async () => Response.json({
    data: [{ id: "approval:1", title: "操作需要批准" }], traceId: "trace-server",
  });
  assert.equal(await runCli(["inbox", "--json"], { io: output, fetch }), 0);
  assert.deepEqual(JSON.parse(output.out[0] ?? ""), {
    ok: true,
    command: "inbox",
    data: [{ id: "approval:1", title: "操作需要批准" }],
  });
});

test("全局 --json 可以写在命令前", async () => {
  const output = io();
  const fetch: typeof globalThis.fetch = async () => Response.json({ data: [], traceId: "trace" });
  assert.equal(await runCli(["--json", "inbox"], { io: output, fetch }), 0);
  assert.deepEqual(JSON.parse(output.out[0] ?? ""), { ok: true, command: "inbox", data: [] });
});

test("写命令生成 Idempotency-Key，且不接受 Base URL/wire format", async () => {
  const output = io();
  let request: Request | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({ data: { id: "workspace-1" }, traceId: "trace" }, { status: 201 });
  };
  assert.equal(await runCli([
    "setup", "--view", "business", "--plugins", "opc", "--provider", "deepseek",
    "--key", "secret", "--workspace", "木牛", "--json",
  ], { io: output, fetch, idempotencyKey: () => "fixed-key" }), 0);
  assert.equal(request?.headers.get("Idempotency-Key"), "fixed-key");
  assert.equal(await runCli(["setup", "--base-url", "https://example.test"], { io: output, fetch }), 2);
  assert.match(output.err.at(-1) ?? "", /不支持的参数/);
});
