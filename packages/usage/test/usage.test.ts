import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyRequestLog } from "@mn/provider-catalog";
import {
  indexLocalSessions,
  exportLocalSession,
  normalizeUsageFromJson,
  normalizeUsageFromResponseBody,
  pricingCatalogFromProviders,
  readLocalSession,
  summarizeProxyRequestLogs
} from "../src/index.js";

test("normalizes OpenAI Responses usage", () => {
  assert.deepEqual(
    normalizeUsageFromJson({
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18
      }
    }),
    {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18
    }
  );
});

test("normalizes OpenAI Chat usage", () => {
  assert.deepEqual(
    normalizeUsageFromJson({
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3
      }
    }),
    {
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8
    }
  );
});

test("normalizes OpenAI cached input and reasoning output details", () => {
  assert.deepEqual(
    normalizeUsageFromJson({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        prompt_tokens_details: {
          cached_tokens: 40
        },
        completion_tokens_details: {
          reasoning_tokens: 12
        }
      }
    }),
    {
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      cachedInputTokens: 40,
      reasoningOutputTokens: 12
    }
  );
});

test("normalizes Anthropic Messages usage from response body", () => {
  assert.deepEqual(
    normalizeUsageFromResponseBody(JSON.stringify({
      usage: {
        input_tokens: 13,
        output_tokens: 21
      }
    })),
    {
      inputTokens: 13,
      outputTokens: 21,
      totalTokens: 34
    }
  );
});

test("normalizes Anthropic cache creation and cache read tokens", () => {
  assert.deepEqual(
    normalizeUsageFromResponseBody(JSON.stringify({
      usage: {
        input_tokens: 13,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
        output_tokens: 21
      }
    })),
    {
      inputTokens: 13,
      outputTokens: 21,
      totalTokens: 46,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 7
    }
  );
});

test("summarizes proxy request logs by app, provider and model", () => {
  const logs: ProxyRequestLog[] = [
    makeLog("claude", "p1", "sonnet", 10, 5),
    { ...makeLog("codex", "p2", "gpt-5", 4, 8), runId: "run-1", candidateId: "codex-1" },
    { ...makeLog("codex", "p2", "gpt-5", 1, 2, 1), runId: "run-1", candidateId: "codex-1" }
  ];

  const summary = summarizeProxyRequestLogs(logs);

  assert.equal(summary.requestCount, 3);
  assert.equal(summary.inputTokens, 15);
  assert.equal(summary.outputTokens, 15);
  assert.equal(summary.totalTokens, 30);
  assert.deepEqual(
    summary.byApp.map((bucket) => [bucket.key, bucket.requestCount, bucket.totalTokens]),
    [
      ["claude", 1, 15],
      ["codex", 2, 15]
    ]
  );
  assert.deepEqual(
    summary.byModel.map((bucket) => [bucket.model, bucket.requestCount, bucket.totalTokens]),
    [
      ["sonnet", 1, 15],
      ["gpt-5", 2, 15]
    ]
  );
  assert.deepEqual(
    summary.byRun.map((bucket) => [bucket.runId, bucket.requestCount, bucket.totalTokens]),
    [["run-1", 2, 15]]
  );
  assert.deepEqual(
    summary.byCandidate.map((bucket) => [
      bucket.runId,
      bucket.candidateId,
      bucket.requestCount,
      bucket.totalTokens
    ]),
    [["run-1", "codex-1", 2, 15]]
  );
});

test("estimates usage cost from provider model pricing", () => {
  const logs: ProxyRequestLog[] = [
    makeLog("codex", "p1", "gpt-priced", 1_000_000, 500_000),
    makeLog("codex", "p1", "gpt-priced", 250_000, 250_000),
    makeLog("codex", "p1", "unpriced", 999, 999)
  ];
  const pricing = pricingCatalogFromProviders([
    {
      id: "p1",
      modelCatalog: [
        {
          id: "gpt-priced",
          displayName: "GPT Priced",
          inputTokenUsdPerMillion: 2,
          outputTokenUsdPerMillion: 8
        },
        {
          id: "unpriced",
          displayName: "Unpriced"
        }
      ]
    }
  ]);

  const summary = summarizeProxyRequestLogs(logs, { pricing });

  assert.equal(summary.estimatedCostUsd, 8.5);
  assert.equal(summary.byProvider[0]?.estimatedCostUsd, 8.5);
  assert.deepEqual(
    summary.byModel.map((bucket) => [bucket.model, bucket.estimatedCostUsd]),
    [
      ["gpt-priced", 8.5],
      ["unpriced", undefined]
    ]
  );
});

test("authoritative reconciliation cost overrides legacy catalog pricing", () => {
  const log = {
    ...makeLog("codex", "p1", "priced", 10, 5),
    authoritativeCostUsd: 3.75
  };
  const pricing = [{
    providerId: "p1",
    model: "priced",
    inputTokenUsdPerMillion: 1,
    outputTokenUsdPerMillion: 1
  }];
  assert.equal(summarizeProxyRequestLogs([log], { pricing }).estimatedCostUsd, 3.75);
});

test("summarizes and prices cache and reasoning token details", () => {
  const logs: ProxyRequestLog[] = [
    {
      ...makeLog("codex", "p1", "detailed-priced", 100, 50),
      cachedInputTokens: 40,
      reasoningOutputTokens: 20
    },
    {
      ...makeLog("claude", "p2", "anthropic-priced", 10, 5),
      cacheCreationInputTokens: 6,
      cacheReadInputTokens: 8
    }
  ];
  const pricing = pricingCatalogFromProviders([
    {
      id: "p1",
      modelCatalog: [
        {
          id: "detailed-priced",
          displayName: "Detailed Priced",
          inputTokenUsdPerMillion: 10,
          cachedInputTokenUsdPerMillion: 1,
          outputTokenUsdPerMillion: 20,
          reasoningOutputTokenUsdPerMillion: 30
        }
      ]
    },
    {
      id: "p2",
      modelCatalog: [
        {
          id: "anthropic-priced",
          displayName: "Anthropic Priced",
          inputTokenUsdPerMillion: 3,
          outputTokenUsdPerMillion: 15,
          cacheCreationInputTokenUsdPerMillion: 4,
          cacheReadInputTokenUsdPerMillion: 0.5
        }
      ]
    }
  ]);

  const summary = summarizeProxyRequestLogs(logs, { pricing });

  assert.equal(summary.cachedInputTokens, 40);
  assert.equal(summary.cacheCreationInputTokens, 6);
  assert.equal(summary.cacheReadInputTokens, 8);
  assert.equal(summary.reasoningOutputTokens, 20);
  assert.equal(summary.totalTokens, 179);
  assert.equal(summary.estimatedCostUsd, 0.001973);
  assert.deepEqual(
    summary.byModel.map((bucket) => [
      bucket.model,
      bucket.cachedInputTokens,
      bucket.cacheCreationInputTokens,
      bucket.cacheReadInputTokens,
      bucket.reasoningOutputTokens
    ]),
    [
      ["detailed-priced", 40, undefined, undefined, 20],
      ["anthropic-priced", undefined, 6, 8, undefined]
    ]
  );
});

test("accumulates tiny costs before rounding", () => {
  const logs: ProxyRequestLog[] = Array.from({ length: 10 }, (_, index) =>
    makeLog("codex", "p1", "tiny-priced", 1, 0, index)
  );
  const pricing = pricingCatalogFromProviders([
    {
      id: "p1",
      modelCatalog: [
        {
          id: "tiny-priced",
          displayName: "Tiny Priced",
          inputTokenUsdPerMillion: 0.001,
          outputTokenUsdPerMillion: 0
        }
      ]
    }
  ]);

  const summary = summarizeProxyRequestLogs(logs, { pricing });

  assert.equal(summary.estimatedCostUsd, 0.00000001);
  assert.equal(summary.byModel[0]?.estimatedCostUsd, 0.00000001);
});

test("indexes Codex and Claude JSONL sessions from a temporary HOME", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-usage-sessions-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  const codexSessionPath = join(homeDir, ".codex", "sessions", "2026", "codex.jsonl");
  await mkdir(join(codexSessionPath, ".."), { recursive: true });
  await writeFile(
    codexSessionPath,
    [
      JSON.stringify({
        timestamp: "2026-07-05T01:00:00.000Z",
        type: "turn_context",
        payload: { cwd: "/repo/codex" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T01:00:01.000Z",
        type: "user_message",
        message: {
          role: "user",
          content: [{ type: "input_text", text: "Build the provider switcher" }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T01:00:01.500Z",
        type: "response_item",
        payload: { item_id: "internal-metadata" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T01:00:02.000Z",
        type: "assistant_message",
        message: {
          role: "assistant",
          model: "gpt-5",
          content: [{ type: "output_text", text: "Done" }],
          usage: {
            input_tokens: 12,
            output_tokens: 4,
            total_tokens: 16
          }
        }
      })
    ].join("\n")
  );

  const claudeSessionPath = join(homeDir, ".claude", "projects", "repo", "claude.jsonl");
  await mkdir(join(claudeSessionPath, ".."), { recursive: true });
  await writeFile(
    claudeSessionPath,
    [
      JSON.stringify({
        timestamp: "2026-07-05T02:00:00.000Z",
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "Review the proxy logs" }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T02:00:01.000Z",
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet",
          content: [{ type: "text", text: "Looks good" }],
          usage: {
            input_tokens: 7,
            output_tokens: 5
          }
        }
      })
    ].join("\n")
  );

  const sessions = await indexLocalSessions({ homeDir });

  assert.deepEqual(
    sessions.map((session) => [session.app, session.title, session.model, session.totalTokens]),
    [
      ["claude", "Review the proxy logs", "claude-sonnet", 12],
      ["codex", "Build the provider switcher", "gpt-5", 16]
    ]
  );
  assert.equal(sessions[1]?.cwd, "/repo/codex");

  const codexDetail = await readLocalSession(sessions[1]?.id ?? "", {
    homeDir,
    apps: ["codex"]
  });
  assert.equal(codexDetail?.messageCount, 2);
  assert.equal(codexDetail?.messages.length, 2);
  assert.equal(codexDetail?.messages[0]?.role, "user");
  assert.equal(codexDetail?.messages[0]?.text, "Build the provider switcher");
  assert.equal(codexDetail?.messages[1]?.usage?.inputTokens, 12);
});

test("indexes real Codex payload message schema and supports redaction", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-usage-real-codex-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  const codexSessionPath = join(homeDir, ".codex", "sessions", "2026", "real.jsonl");
  await mkdir(join(codexSessionPath, ".."), { recursive: true });
  await writeFile(
    codexSessionPath,
    [
      JSON.stringify({
        timestamp: "2026-07-05T01:00:00.000Z",
        type: "turn_context",
        payload: { cwd: "/Users/alice/private-repo" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T01:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Use API_KEY=sk-1234567890abcdef in /Users/alice/private-repo"
        }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T01:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Calling upstream with Bearer abc.def.ghi"
        }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T01:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          model: "gpt-5",
          content: [{ type: "output_text", text: "Finished safely" }],
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7
          }
        }
      })
    ].join("\n")
  );

  const sessions = await indexLocalSessions({
    homeDir,
    apps: ["codex"],
    query: "API_KEY"
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.messageCount, 3);
  assert.equal(sessions[0]?.title, "Use API_KEY=sk-1234567890abcdef in /Users/alice/private-repo");
  assert.equal(sessions[0]?.cwd, "/Users/alice/private-repo");
  assert.equal(sessions[0]?.model, "gpt-5");
  assert.equal(sessions[0]?.totalTokens, 7);

  const detail = await readLocalSession(sessions[0]?.id ?? "", {
    homeDir,
    apps: ["codex"]
  });
  assert.deepEqual(
    detail?.messages.map((message) => [message.role, message.text]),
    [
      ["user", "Use API_KEY=sk-1234567890abcdef in /Users/alice/private-repo"],
      ["assistant", "Calling upstream with Bearer abc.def.ghi"],
      ["assistant", "Finished safely"]
    ]
  );

  const redacted = await readLocalSession(sessions[0]?.id ?? "", {
    homeDir,
    apps: ["codex"],
    redact: true
  });
  assert.equal(
    redacted?.title,
    "Use API_KEY=**** in /Users/<user>/private-repo"
  );
  assert.equal(redacted?.cwd, "/Users/<user>/private-repo");
  assert.equal(
    redacted?.messages[0]?.text,
    "Use API_KEY=**** in /Users/<user>/private-repo"
  );
  assert.equal(redacted?.messages[1]?.text, "Calling upstream with Bearer ****");

  const exported = await exportLocalSession(sessions[0]?.id ?? "", {
    homeDir,
    apps: ["codex"],
    redact: true
  });
  assert.equal(exported?.version, 1);
  assert.equal(exported?.kind, "mniu.session.export");
  assert.equal(exported?.redacted, true);
  assert.equal(exported?.session.cwd, "/Users/<user>/private-repo");
  assert.equal(
    exported?.session.messages[0]?.text,
    "Use API_KEY=**** in /Users/<user>/private-repo"
  );
});

test("filters and paginates local sessions by query", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-usage-session-search-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  const sessionDir = join(homeDir, ".codex", "sessions", "2026");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "alpha.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-07-05T01:00:00.000Z",
        type: "turn_context",
        payload: { cwd: "/repo/app" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T01:00:01.000Z",
        type: "user_message",
        message: { role: "user", content: "Prepare release notes" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T01:00:02.000Z",
        type: "assistant_message",
        message: { role: "assistant", content: "Release notes ready" }
      })
    ].join("\n")
  );
  await writeFile(
    join(sessionDir, "billing-old.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-07-05T02:00:00.000Z",
        type: "turn_context",
        payload: { cwd: "/repo/payments" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T02:00:01.000Z",
        type: "user_message",
        message: { role: "user", content: "Investigate budget drift" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T02:00:02.000Z",
        type: "assistant_message",
        message: { role: "assistant", content: "Billing reconciliation found one mismatch" }
      })
    ].join("\n")
  );
  await writeFile(
    join(sessionDir, "billing-new.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-07-05T03:00:00.000Z",
        type: "turn_context",
        payload: { cwd: "/repo/billing" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T03:00:01.000Z",
        type: "user_message",
        message: { role: "user", content: "Billing cleanup" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T03:00:02.000Z",
        type: "assistant_message",
        message: { role: "assistant", content: "Cleanup complete" }
      })
    ].join("\n")
  );

  const firstPage = await indexLocalSessions({
    homeDir,
    apps: ["codex"],
    query: "billing",
    limit: 1
  });
  assert.deepEqual(firstPage.map((session) => session.title), ["Billing cleanup"]);

  const secondPage = await indexLocalSessions({
    homeDir,
    apps: ["codex"],
    query: "billing",
    limit: 1,
    offset: 1
  });
  assert.deepEqual(secondPage.map((session) => session.title), ["Investigate budget drift"]);

  const cwdMatch = await indexLocalSessions({
    homeDir,
    apps: ["codex"],
    query: "/repo/payments"
  });
  assert.deepEqual(cwdMatch.map((session) => session.title), ["Investigate budget drift"]);

  const missing = await indexLocalSessions({
    homeDir,
    apps: ["codex"],
    query: "not-present"
  });
  assert.equal(missing.length, 0);
});

test("refreshes cached session summaries when JSONL files change", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-usage-session-cache-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  const sessionPath = join(homeDir, ".codex", "sessions", "cache.jsonl");
  await mkdir(join(sessionPath, ".."), { recursive: true });
  await writeFile(
    sessionPath,
    JSON.stringify({
      timestamp: "2026-07-05T01:00:00.000Z",
      type: "user_message",
      message: { role: "user", content: "Original title" }
    })
  );
  const first = await indexLocalSessions({ homeDir, apps: ["codex"] });
  assert.equal(first[0]?.title, "Original title");

  await writeFile(
    sessionPath,
    JSON.stringify({
      timestamp: "2026-07-05T01:00:00.000Z",
      type: "user_message",
      message: { role: "user", content: "Updated title after cache invalidation" }
    })
  );
  const second = await indexLocalSessions({ homeDir, apps: ["codex"] });
  assert.equal(second[0]?.title, "Updated title after cache invalidation");
});

function makeLog(
  app: ProxyRequestLog["app"],
  providerId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  suffix = 0
): ProxyRequestLog {
  return {
    id: `${app}-${providerId}-${model}-${inputTokens}-${suffix}`,
    app,
    providerId,
    model,
    inputTokens,
    outputTokens,
    statusCode: 200,
    latencyMs: 10,
    createdAt: new Date(0).toISOString()
  };
}
