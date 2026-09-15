// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export async function generateResponseSchemas({ check = false } = {}) {
  const entry = fileURLToPath(new URL("../../packages/contracts/src/api-outputs.ts", import.meta.url));
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true,
  });
  const diagnostics = program.getSemanticDiagnostics().filter((item) => item.file?.fileName.includes("/packages/contracts/src/"));
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  }));
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const declaration = source.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === "ApiOutputsV2");
  if (!declaration) throw new Error("缺少 ApiOutputsV2");
  const schemas = {
    OutputJsonValue: { anyOf: [
      { type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string" },
      { type: "array", items: { $ref: "#/components/schemas/OutputJsonValue" } },
      { type: "object", additionalProperties: { $ref: "#/components/schemas/OutputJsonValue" } },
    ] },
    OutputJsonObject: { type: "object", additionalProperties: { $ref: "#/components/schemas/OutputJsonValue" } },
  };
  const namedTypes = new Map();
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  function schema(type, inline = false) {
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const name = symbol?.name;
    if (name === "ArrayBuffer") return { type: "string", format: "binary" };
    if (name === "JsonValue" || name === "JsonObject") return ref(`Output${name}`);
    if (!inline && name && !name.startsWith("__")
      && symbol.declarations?.some((node) => node.getSourceFile().fileName.includes("/packages/contracts/src/"))) {
      const key = `Output${name}`;
      if (namedTypes.has(key) && namedTypes.get(key) !== type) throw new Error(`响应类型名称冲突：${name}`);
      if (!namedTypes.has(key)) {
        namedTypes.set(key, type);
        schemas[key] = schema(type, true);
      }
      return ref(key);
    }
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
      throw new Error(`响应字段必须声明 JSON 类型：${checker.typeToString(type)}`);
    }
    if (type.isUnion()) {
      const members = type.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined));
      if (members.length === 1) return schema(members[0]);
      return { anyOf: members.map((member) => schema(member)) };
    }
    if (type.flags & ts.TypeFlags.StringLiteral) return { type: "string", const: type.value };
    if (type.flags & ts.TypeFlags.NumberLiteral) return { type: "number", const: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: "boolean", const: type.intrinsicName === "true" };
    if (type.flags & ts.TypeFlags.String) return { type: "string" };
    if (type.flags & ts.TypeFlags.Number) return { type: "number" };
    if (type.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (type.flags & ts.TypeFlags.Null) return { type: "null" };
    if (checker.isArrayType(type)) return { type: "array", items: schema(checker.getTypeArguments(type)[0]) };
    if (type.flags & ts.TypeFlags.Object || type.isIntersection()) {
      const properties = {};
      const required = [];
      for (const property of checker.getPropertiesOfType(type)) {
        properties[property.name] = schema(checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? declaration));
        if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
      }
      const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
      return { type: "object", additionalProperties: index ? schema(index) : false, required, properties };
    }
    throw new Error(`不支持的响应类型：${checker.typeToString(type)}`);
  }
  const outputs = {};
  for (const operation of checker.getPropertiesOfType(checker.getTypeAtLocation(declaration))) {
    outputs[operation.name] = schema(checker.getTypeOfSymbolAtLocation(operation, declaration));
  }
  const content = `// Generated from api-outputs.ts. Do not edit.\n// SPDX-License-Identifier: Apache-2.0\nimport type { JsonObject } from "./json.js";\nexport const API_OUTPUT_SCHEMAS_V2: Readonly<Record<string, JsonObject>> = ${JSON.stringify(outputs, null, 2)};\nexport const API_OUTPUT_COMPONENTS_V2: Readonly<Record<string, JsonObject>> = ${JSON.stringify(schemas, null, 2)};\n`;
  const path = new URL("../../packages/contracts/src/generated-responses.ts", import.meta.url);
  if (check) {
    if (await readFile(path, "utf8").catch(() => "") !== content) throw new Error("响应契约过期，请运行 npm run generate:contracts");
  } else await writeFile(path, content);
}
