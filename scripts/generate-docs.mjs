// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";
import { stringify as stringifyYaml } from "yaml";

const root = process.cwd();
const check = process.argv.includes("--check");
const generatedFiles = new Map();
const generatedBlocks = [];

function fail(message) {
  throw new Error(`0.2 文档生成失败：${message}`);
}

function addBlock(path, id, body) {
  generatedBlocks.push({ path: join(root, path), id, body: body.trimEnd() });
}

function addFile(path, content) {
  generatedFiles.set(join(root, path), content.endsWith("\n") ? content : `${content}\n`);
}

function parseOperations(source) {
  const pattern = /\{ method: "(get|post|put|patch|delete)", path: "([^"]+)", operationId: "([^"]+)", mutation: (true|false), versioned: (true|false) \}/gu;
  const operations = [...source.matchAll(pattern)].map((match) => ({
    method: match[1],
    path: match[2],
    operationId: match[3],
    mutation: match[4] === "true",
    versioned: match[5] === "true",
  }));
  if (operations.length === 0) fail("无法从 packages/contracts/src/openapi.ts 读取 API_OPERATIONS_V2");
  if (operations.some((operation) => !operation.path.startsWith("/v2/"))) {
    fail("公共契约包含非 0.2 路由");
  }
  return operations;
}

function operationTable(operations) {
  return [
    "| 方法 | 路径 | operationId | 幂等键 | stream version |",
    "| --- | --- | --- | --- | --- |",
    ...operations.map((operation) => [
      `| \`${operation.method.toUpperCase()}\``,
      `\`${operation.path}\``,
      `\`${operation.operationId}\``,
      operation.mutation ? "必需" : "—",
      operation.versioned ? "必需 |" : "— |",
    ].join(" | ")),
  ].join("\n");
}

function pathParameters(path) {
  return [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => ({
    in: "path",
    name: match[1],
    required: true,
    schema: match[1] === "runnerId"
      ? { type: "string", enum: ["claude-cli", "codex-cli"] }
      : { type: "string" },
    ...(match[1] === "path" ? { description: "插件领域内的相对资源或命令路径" } : {}),
  }));
}

function operationParameters(operation) {
  const parameters = pathParameters(operation.path);
  if (operation.mutation) parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
  if (operation.operationId === "streamWorkspaceEvents") {
    parameters.push(
      { $ref: "#/components/parameters/LastEventId" },
      {
        name: "after",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0 },
      },
    );
  }
  if (operation.operationId === "listInbox") {
    parameters.push({ name: "workspaceId", in: "query", required: false, schema: { type: "string" } });
  }
  if (operation.operationId === "getAsset") {
    parameters.push({
      name: "content",
      in: "query",
      required: false,
      schema: { type: "integer", enum: [1] },
    });
  }
  if (operation.operationId === "listMemories") {
    parameters.push({ name: "namespace", in: "query", required: false, schema: { type: "string" } });
  }
  if (operation.operationId === "listCodingRunners") {
    parameters.push({ name: "workspaceId", in: "query", required: true, schema: { type: "string" } });
  }
  return parameters;
}

function mutationSchema(operation) {
  const schemas = {
    createAssets: "CreateAssetsMutation",
    deleteAsset: "DeleteAssetMutation",
    createTurn: "CreateTurnMutation",
    commandOpcOpportunity: "OpcOpportunityCommandMutation",
    inspectCodingRunner: "InspectCodingRunnerMutation",
    confirmCodingRunner: "ConfirmCodingRunnerMutation",
  };
  const schema = schemas[operation.operationId];
  if (schema) return { $ref: `#/components/schemas/${schema}` };
  return operation.versioned
    ? { $ref: "#/components/schemas/VersionedMutation" }
    : { $ref: "#/components/schemas/Mutation" };
}

function successStatus(operationId) {
  if (operationId === "createTurn") return "202";
  if ([
    "createWorkspace",
    "createThread",
    "createAssets",
    "proposeMemory",
    "createShareGrant",
    "createModelConnection",
    "installPlugin",
  ].includes(operationId)) return "201";
  return "200";
}

function openApiDocument(operations) {
  const paths = {};
  for (const operation of operations) {
    const parameters = operationParameters(operation);
    const responses = operation.operationId === "streamWorkspaceEvents"
      ? {
          "200": {
            description: "使用 tenant position 作为 id 的事件流",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "410": { $ref: "#/components/responses/CursorExpired" },
          default: { $ref: "#/components/responses/Error" },
        }
      : {
          [successStatus(operation.operationId)]: operation.operationId === "inspectCodingRunner"
            ? {
                description: "返回未执行目标路径所得的文件身份摘要",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/RunnerBinaryInspectionEnvelope" },
                  },
                },
              }
            : { $ref: "#/components/responses/Success" },
          ...(operation.mutation ? { "409": { $ref: "#/components/responses/Conflict" } } : {}),
          default: { $ref: "#/components/responses/Error" },
        };
    const definition = {
      operationId: operation.operationId,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(operation.mutation ? {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: mutationSchema(operation),
            },
          },
        },
      } : {}),
      responses,
      "x-muniu-versioned": operation.versioned,
      ...(operation.path.endsWith("/{path}") ? { "x-muniu-greedy-path": true } : {}),
    };
    paths[operation.path] ??= {};
    paths[operation.path][operation.method] = definition;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Muniu Agent OS API",
      version: "0.2.0",
      description: "Agent OS 0.2 的公共 Host 契约",
    },
    servers: [{ url: "http://127.0.0.1:7318" }],
    paths,
    components: {
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 1 },
        },
        LastEventId: {
          name: "Last-Event-ID",
          in: "header",
          required: false,
          schema: { type: "integer", minimum: 0 },
        },
      },
      responses: {
        Success: {
          description: "成功",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } },
        },
        Conflict: {
          description: "stream version 或幂等键冲突",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
        },
        CursorExpired: {
          description: "事件游标已超出保留期",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
        },
        Error: {
          description: "统一错误",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
        },
      },
      schemas: {
        Mutation: { type: "object", additionalProperties: true },
        VersionedMutation: {
          type: "object",
          required: ["expectedStreamVersion"],
          properties: { expectedStreamVersion: { type: "integer", minimum: 0 } },
          additionalProperties: true,
        },
        CreateAssetsMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "expectedStreamVersion", "attachments"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            expectedStreamVersion: { type: "integer", const: 0 },
            attachments: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["fileName", "mediaType", "contentBase64"],
                properties: {
                  fileName: { type: "string", minLength: 1 },
                  mediaType: {
                    type: "string",
                    enum: [
                      "text/plain", "text/markdown", "application/json", "text/csv",
                      "application/pdf", "image/png", "image/jpeg", "image/webp",
                    ],
                  },
                  contentBase64: { type: "string", contentEncoding: "base64" },
                  protected: { type: "boolean", default: false },
                },
              },
            },
          },
        },
        DeleteAssetMutation: {
          type: "object",
          additionalProperties: false,
          required: ["expectedStreamVersion", "reason"],
          properties: {
            expectedStreamVersion: { type: "integer", minimum: 1 },
            reason: { type: "string", minLength: 1 },
          },
        },
        OpcOpportunityCommandMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "expectedStreamVersion", "command", "input"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            expectedStreamVersion: { type: "integer", minimum: 1 },
            command: { type: "string", minLength: 1 },
            input: { type: "object", additionalProperties: true },
          },
          allOf: [
            {
              if: { required: ["command"], properties: { command: { const: "record_interview" } } },
              then: {
                properties: {
                  input: {
                    type: "object",
                    required: ["interviewId", "participantRef", "occurredAt", "rawRecordAssetId"],
                    not: { required: ["rawRecord"] },
                  },
                },
              },
            },
            {
              if: {
                required: ["command", "input"],
                properties: {
                  command: { const: "record_signal" },
                  input: {
                    type: "object",
                    required: ["sourceKind"],
                    properties: { sourceKind: { const: "file" } },
                  },
                },
              },
              then: {
                properties: {
                  input: { type: "object", required: ["sourceAssetId"] },
                },
              },
            },
          ],
        },
        CreateTurnMutation: {
          type: "object",
          additionalProperties: false,
          required: ["expectedStreamVersion", "message"],
          properties: {
            expectedStreamVersion: { type: "integer", minimum: 0 },
            message: { type: "string", minLength: 1 },
            agentDefinitionId: { type: "string", minLength: 1 },
            modelBindingId: { type: "string", minLength: 1 },
            runnerId: { type: "string", enum: ["builtin", "claude-cli", "codex-cli"] },
          },
        },
        InspectCodingRunnerMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "binaryPath"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            binaryPath: { type: "string", minLength: 1, pattern: "^/" },
          },
        },
        ConfirmCodingRunnerMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "expectedStreamVersion", "binaryPath", "version", "sha256"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            expectedStreamVersion: { type: "integer", minimum: 0 },
            binaryPath: { type: "string", minLength: 1, pattern: "^/" },
            version: { type: "string", minLength: 1, maxLength: 256 },
            sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
        Envelope: {
          type: "object",
          required: ["data", "traceId"],
          properties: { data: {}, traceId: { type: "string" } },
        },
        RunnerBinaryInspectionEnvelope: {
          type: "object",
          additionalProperties: false,
          required: ["data", "traceId"],
          properties: {
            data: { $ref: "#/components/schemas/RunnerBinaryInspection" },
            traceId: { type: "string" },
          },
        },
        RunnerBinaryInspection: {
          type: "object",
          additionalProperties: false,
          required: [
            "requestedPath", "realPath", "sha256", "device", "inode", "byteLength", "modifiedAtMs",
          ],
          properties: {
            requestedPath: { type: "string", minLength: 1 },
            realPath: { type: "string", minLength: 1 },
            sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            device: { type: "string", minLength: 1 },
            inode: { type: "string", minLength: 1 },
            byteLength: { type: "integer", minimum: 1 },
            modifiedAtMs: { type: "number", minimum: 0 },
          },
        },
        FieldIssue: {
          type: "object",
          required: ["field", "message"],
          properties: { field: { type: "string" }, message: { type: "string" } },
        },
        ApiError: {
          type: "object",
          required: ["code", "message", "action", "fieldIssues", "traceId", "retryable"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            action: { type: "string" },
            fieldIssues: { type: "array", items: { $ref: "#/components/schemas/FieldIssue" } },
            traceId: { type: "string" },
            retryable: { type: "boolean" },
          },
        },
      },
    },
  };
}

async function pluginCatalog() {
  const pluginRoot = join(root, "plugins");
  const entries = [];
  for (const directory of await readdir(pluginRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const manifestPath = join(pluginRoot, directory.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (manifest.version !== "0.2.0") fail(`${relative(root, manifestPath)} 版本不是 0.2.0`);
    const runner = directory.name.startsWith("runner-");
    entries.push({
      id: directory.name,
      packageName: manifest.name,
      version: manifest.version,
      kind: runner ? "Runner Adapter" : "产品插件",
      activation: runner ? "可选，必须显式选择" : "随应用提供，按工作区启用",
    });
  }
  entries.sort((left, right) => Number(left.kind !== "产品插件") - Number(right.kind !== "产品插件")
    || left.id.localeCompare(right.id));
  if (entries.length === 0) fail("plugins/ 中没有 0.2 插件包");
  return [
    "| 插件 ID | 包 | 版本 | 类型 | 启用方式 |",
    "| --- | --- | --- | --- | --- |",
    ...entries.map((entry) => `| \`${entry.id}\` | \`${entry.packageName}\` | \`${entry.version}\` | ${entry.kind} | ${entry.activation} |`),
  ].join("\n");
}

const contractSource = await readFile(join(root, "packages/contracts/src/openapi.ts"), "utf8");
const operations = parseOperations(contractSource);
addBlock("docs/reference/api-routes.md", "contracts-routes", operationTable(operations));
addFile("docs/reference/openapi.yaml", stringifyYaml(openApiDocument(operations), { lineWidth: 0 }));

const cliSource = await readFile(join(root, "apps/cli/src/index.ts"), "utf8");
const cliHelp = /const HELP = `([\s\S]*?)`;/u.exec(cliSource)?.[1];
if (!cliHelp) fail("无法从 apps/cli/src/index.ts 读取 HELP");
addBlock("docs/reference/cli.md", "cli-help", `\`\`\`text\n${cliHelp.trimEnd()}\n\`\`\``);
addBlock("docs/reference/plugins.md", "plugin-catalog", await pluginCatalog());

let stale = false;
for (const block of generatedBlocks) {
  const source = await readFile(block.path, "utf8");
  const start = `<!-- generated:${block.id}:start -->`;
  const end = `<!-- generated:${block.id}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) fail(`${relative(root, block.path)} 缺少 ${block.id} marker`);
  const replacement = `${start}\n\n${block.body}\n\n${end}`;
  const expected = `${source.slice(0, startIndex)}${replacement}${source.slice(endIndex + end.length)}`;
  if (source === expected) continue;
  if (check) {
    console.error(`生成内容未更新：${relative(root, block.path)}#${block.id}`);
    stale = true;
  } else {
    await writeFile(block.path, expected, "utf8");
  }
}

for (const [path, expected] of generatedFiles) {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    // A missing generated file is reported as stale in check mode.
  }
  if (current === expected) continue;
  if (check) {
    console.error(`生成文件未更新：${relative(root, path)}`);
    stale = true;
  } else {
    await writeFile(path, expected, "utf8");
  }
}

if (stale) process.exitCode = 1;
