import assert from "node:assert/strict";
import test from "node:test";
import { redactConfigContent } from "../src/index.js";

test("redactConfigContent recursively redacts JSON secrets", () => {
  const input = `${JSON.stringify({
    tokens: {
      access_token: "access-value",
      refresh_token: "refresh-value"
    },
    auth: { scheme: "Bearer", value: "auth-value" },
    nested: [{ clientSecret: "secret-value", model: "gpt-5" }],
    apiKey: "camel-key"
  })}\n`;

  const output = redactConfigContent(input);
  assert.equal(output.includes("access-value"), false);
  assert.equal(output.includes("refresh-value"), false);
  assert.equal(output.includes("auth-value"), false);
  assert.equal(output.includes("secret-value"), false);
  assert.equal(output.includes("camel-key"), false);
  assert.equal(JSON.parse(output).tokens.access_token, "****");
  assert.equal(JSON.parse(output).nested[0].model, "gpt-5");
});

test("redactConfigContent redacts TOML tables, dotted keys, and inline tables", () => {
  const input = [
    "# keep this comment",
    'experimental_bearer_token = "top-secret"',
    'credentials = { access_token = "inline-access", label = "safe" }',
    '[provider.auth]',
    'refresh_token = "table-refresh"',
    'api_key = "table-key"',
    ""
  ].join("\n");

  const output = redactConfigContent(input);
  assert.equal(output.includes("top-secret"), false);
  assert.equal(output.includes("inline-access"), false);
  assert.equal(output.includes("table-refresh"), false);
  assert.equal(output.includes("table-key"), false);
  assert.match(output, /# keep this comment/);
  assert.equal(output.includes('label = "safe"'), false);
  assert.match(output, /\*\*\*\*/);
});

test("redactConfigContent preserves configs without sensitive values", () => {
  const input = '# user config\nmodel = "gpt-5"\nmax_tokens = 4096\n';
  assert.equal(redactConfigContent(input), input);
});

test("redactConfigContent fails closed for malformed config text", () => {
  const inputs = [
    'access_token = "broken-secret"\ninvalid = [\n',
    "access_token = 'single-secret'\ninvalid = [\n",
    'password = bare-secret\ninvalid = [\n',
    '{"accessToken": 123456,',
    "'access_token' = 'quoted-key-secret'\ninvalid = [\n",
    '"auth.token" = "dotted-key-secret"\ninvalid = [\n'
  ];
  for (const input of inputs) {
    const output = redactConfigContent(input);
    assert.match(output, /^\[REDACTED INVALID CONFIG\]/);
    assert.equal(output.includes("secret"), false);
    assert.equal(output.includes("123456"), false);
  }
});
