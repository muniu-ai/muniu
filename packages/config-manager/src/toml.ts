import * as TOML from "@iarna/toml";
import { isDeepStrictEqual } from "node:util";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";

export type TomlPrimitive = string | number | boolean | Date;
export type TomlValue = TomlPrimitive | TomlValue[] | { [key: string]: TomlValue };

export interface TomlDocument {
  values: Record<string, TomlValue>;
  tables: Record<string, Record<string, TomlValue>>;
  readonly source: string;
  readonly sourceData: Record<string, TomlValue>;
  readonly originalValues: Record<string, TomlValue>;
  readonly originalTables: Record<string, Record<string, TomlValue>>;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export function parseToml(input: string): TomlDocument {
  parseTOML(input, { tomlVersion: "1.0" });
  const sourceData = TOML.parse(input) as Record<string, TomlValue>;
  const { values, tables } = flattenToml(sourceData);
  return {
    values,
    tables,
    source: input,
    sourceData,
    originalValues: cloneToml(values),
    originalTables: cloneToml(tables)
  };
}

export function stringifyToml(document: TomlDocument): string {
  if (!document.source) return stringifyNewDocument(document);

  const ast = parseTOML(document.source, { tomlVersion: "1.0" });
  const root = ast.body[0];
  const topLevel = new Map<string, AST.TOMLKeyValue>();
  const tableNodes = new Map<string, AST.TOMLTable>();
  const valueNodes = new Map<string, AST.TOMLKeyValue>();
  for (const node of root.body) {
    if (node.type === "TOMLKeyValue") {
      topLevel.set(keyName(node.key), node);
      collectValueNodes(node, [], valueNodes);
    } else if (node.kind === "standard") {
      const tableName = resolvedTableName(node);
      tableNodes.set(tableName, node);
      for (const item of node.body) collectValueNodes(item, tableName.split("."), valueNodes);
    }
  }

  const desiredData = materializeDocument(document);
  const rewrittenInlineRoots = new Set<string>();

  const edits: TextEdit[] = [];
  const topLevelAdditions: string[] = [];
  for (const key of Object.keys(document.originalValues)) {
    if (!(key in document.values)) {
      const node = topLevel.get(key);
      if (node) edits.push({ start: node.range[0], end: node.range[1], text: "" });
    }
  }
  for (const [key, value] of Object.entries(document.values)) {
    if (isDeepStrictEqual(value, document.originalValues[key])) continue;
    const node = topLevel.get(key);
    if (node) {
      edits.push({
        start: node.value.range[0],
        end: node.value.range[1],
        text: stringifyValue(value)
      });
    } else {
      topLevelAdditions.push(`${formatKey(key)} = ${stringifyValue(value)}`);
    }
  }
  const appendedTables: string[] = [];
  for (const tableName of Object.keys(document.originalTables)) {
    if (tableName in document.tables) continue;
    const node = tableNodes.get(tableName);
    if (!node) continue;
    edits.push({
      start: node.range[0],
      end: tableHeaderEnd(document.source, node),
      text: ""
    });
    for (const item of node.body) {
      edits.push({ start: item.range[0], end: item.range[1], text: "" });
    }
  }
  for (const [tableName, table] of Object.entries(document.tables)) {
    const original = document.originalTables[tableName];
    if (original && isDeepStrictEqual(table, original)) continue;
    const node = tableNodes.get(tableName);
    if (!node) {
      const inlineRoot = inlineRootForTable(tableName, topLevel);
      if (inlineRoot) {
        if (!rewrittenInlineRoots.has(inlineRoot)) {
          const inlineNode = topLevel.get(inlineRoot);
          const inlineValue = desiredData[inlineRoot];
          if (inlineNode && isTable(inlineValue)) {
            edits.push({
              start: inlineNode.value.range[0],
              end: inlineNode.value.range[1],
              text: stringifyInlineTable(inlineValue)
            });
            rewrittenInlineRoots.add(inlineRoot);
          }
        }
        continue;
      }

      const additions: string[] = [];
      for (const [key, value] of Object.entries(table)) {
        if (original && isDeepStrictEqual(value, original[key])) continue;
        const item = valueNodes.get(`${tableName}.${key}`);
        if (item) {
          edits.push({
            start: item.value.range[0],
            end: item.value.range[1],
            text: stringifyValue(value)
          });
        } else {
          additions.push(
            `${formatDottedKey(`${tableName}.${key}`)} = ${stringifyValue(value)}`
          );
        }
      }
      for (const key of Object.keys(original ?? {})) {
        if (key in table) continue;
        const item = valueNodes.get(`${tableName}.${key}`);
        if (item) edits.push({ start: item.range[0], end: lineEnd(document.source, item.range[1]), text: "" });
      }
      topLevelAdditions.push(...additions);
      continue;
    }

    const items = new Map(node.body.map((item) => [keyName(item.key), item]));
    const additions: string[] = [];
    for (const key of Object.keys(original ?? {})) {
      if (key in table) continue;
      const item = items.get(key);
      if (item) edits.push({ start: item.range[0], end: item.range[1], text: "" });
    }
    for (const [key, value] of Object.entries(table)) {
      if (original && isDeepStrictEqual(value, original[key])) continue;
      const item = items.get(key);
      if (item) {
        edits.push({
          start: item.value.range[0],
          end: item.value.range[1],
          text: stringifyValue(value)
        });
      } else {
        additions.push(`${formatKey(key)} = ${stringifyValue(value)}`);
      }
    }
    if (additions.length > 0) {
      const anchor = node.body.at(-1) ?? node;
      const insertion = lineEnd(document.source, anchor.range[1]);
      const prefix = insertion === document.source.length && !document.source.endsWith("\n") ? "\n" : "";
      edits.push({
        start: insertion,
        end: insertion,
        text: `${prefix}${additions.join("\n")}\n`
      });
    }
  }
  if (topLevelAdditions.length > 0) {
    const firstTable = root.body.find((node): node is AST.TOMLTable => node.type === "TOMLTable");
    const insertion = firstTable ? lineStart(document.source, firstTable.range[0]) : document.source.length;
    const prefix = insertion > 0 && document.source[insertion - 1] !== "\n" ? "\n" : "";
    edits.push({
      start: insertion,
      end: insertion,
      text: `${prefix}${topLevelAdditions.join("\n")}\n`
    });
  }
  if (appendedTables.length > 0) {
    const prefix = document.source.endsWith("\n") ? "\n" : "\n\n";
    edits.push({
      start: document.source.length,
      end: document.source.length,
      text: `${prefix}${appendedTables.join("\n\n")}\n`
    });
  }

  const output = applyEdits(document.source, edits);
  parseTOML(output, { tomlVersion: "1.0" });
  TOML.parse(output);
  return output.endsWith("\n") ? output : `${output}\n`;
}

function stringifyNewDocument(document: TomlDocument): string {
  const data = cloneToml(document.sourceData);
  for (const [key, value] of Object.entries(document.values)) data[key] = cloneToml(value);
  for (const [tableName, table] of Object.entries(document.tables)) {
    updateTable(data, tableName, {}, table);
  }
  return `${TOML.stringify(data as unknown as Parameters<typeof TOML.stringify>[0]).trimEnd()}\n`;
}

function stringifyValue(value: TomlValue): string {
  const serialized = TOML.stringify({ __value__: value } as Parameters<typeof TOML.stringify>[0]).trimEnd();
  const prefix = "__value__ = ";
  if (!serialized.startsWith(prefix) || serialized.includes("\n[__value__]")) {
    throw new Error("TOML table values must be projected as named tables");
  }
  return serialized.slice(prefix.length);
}

function stringifyTable(tableName: string, table: Record<string, TomlValue>): string {
  return [
    `[${tableName.split(".").map(formatKey).join(".")}]`,
    ...Object.entries(table).map(([key, value]) => `${formatKey(key)} = ${stringifyValue(value)}`)
  ].join("\n");
}

function stringifyInlineTable(table: Record<string, TomlValue>): string {
  return `{ ${Object.entries(table)
    .map(([key, value]) => `${formatKey(key)} = ${stringifyInlineValue(value)}`)
    .join(", ")} }`;
}

function stringifyInlineValue(value: TomlValue): string {
  return isTable(value) ? stringifyInlineTable(value) : stringifyValue(value);
}

function formatDottedKey(path: string): string {
  return path.split(".").map(formatKey).join(".");
}

function formatKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function keyName(key: AST.TOMLKey): string {
  return (getStaticTOMLValue(key) as string[]).join(".");
}

function collectValueNodes(
  node: AST.TOMLKeyValue,
  prefix: string[],
  nodes: Map<string, AST.TOMLKeyValue>
): void {
  const path = [...prefix, ...keySegments(node.key)];
  nodes.set(path.join("."), node);
  if (node.value.type === "TOMLInlineTable") {
    for (const item of node.value.body) collectValueNodes(item, path, nodes);
  }
}

function keySegments(key: AST.TOMLKey): string[] {
  return getStaticTOMLValue(key) as string[];
}

function inlineRootForTable(
  tableName: string,
  topLevel: Map<string, AST.TOMLKeyValue>
): string | undefined {
  const root = tableName.split(".")[0];
  const node = root ? topLevel.get(root) : undefined;
  return node?.value.type === "TOMLInlineTable" ? root : undefined;
}

function resolvedTableName(table: AST.TOMLTable): string {
  return table.resolvedKey.filter((segment): segment is string => typeof segment === "string").join(".");
}

function tableHeaderEnd(source: string, table: AST.TOMLTable): number {
  const closingBrackets = table.kind === "array" ? 2 : 1;
  let index = table.key.range[1];
  let remaining = closingBrackets;
  while (index < source.length && remaining > 0) {
    if (source[index] === "]") remaining -= 1;
    index += 1;
  }
  return index;
}

function lineStart(source: string, index: number): number {
  const newline = source.lastIndexOf("\n", Math.max(0, index - 1));
  return newline < 0 ? 0 : newline + 1;
}

function lineEnd(source: string, index: number): number {
  const newline = source.indexOf("\n", index);
  return newline < 0 ? source.length : newline + 1;
}

function applyEdits(source: string, edits: TextEdit[]): string {
  return edits
    .map((edit, order) => ({ ...edit, order }))
    .sort((left, right) => right.start - left.start || right.order - left.order)
    .reduce(
      (output, edit) => `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`,
      source
    );
}

function flattenToml(data: Record<string, TomlValue>): {
  values: Record<string, TomlValue>;
  tables: Record<string, Record<string, TomlValue>>;
} {
  const values: Record<string, TomlValue> = {};
  const tables: Record<string, Record<string, TomlValue>> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isTable(value)) flattenTable(value, key, tables);
    else values[key] = cloneToml(value);
  }
  return { values, tables };
}

function materializeDocument(document: TomlDocument): Record<string, TomlValue> {
  const data = cloneToml(document.sourceData);
  for (const key of Object.keys(document.originalValues)) {
    if (!(key in document.values)) delete data[key];
  }
  for (const [key, value] of Object.entries(document.values)) data[key] = cloneToml(value);
  for (const [tableName, original] of Object.entries(document.originalTables)) {
    updateTable(data, tableName, original, document.tables[tableName] ?? {});
  }
  for (const [tableName, table] of Object.entries(document.tables)) {
    if (!(tableName in document.originalTables)) updateTable(data, tableName, {}, table);
  }
  return data;
}

function flattenTable(
  table: Record<string, TomlValue>,
  tableName: string,
  tables: Record<string, Record<string, TomlValue>>
): void {
  const direct: Record<string, TomlValue> = {};
  for (const [key, value] of Object.entries(table)) {
    if (isTable(value)) flattenTable(value, `${tableName}.${key}`, tables);
    else direct[key] = cloneToml(value);
  }
  tables[tableName] = direct;
}

function updateTable(
  data: Record<string, TomlValue>,
  tableName: string,
  original: Record<string, TomlValue>,
  next: Record<string, TomlValue>
): void {
  const table = ensurePath(data, tableName);
  for (const key of Object.keys(original)) if (!(key in next)) delete table[key];
  for (const [key, value] of Object.entries(next)) table[key] = cloneToml(value);
}

function ensurePath(data: Record<string, TomlValue>, path: string): Record<string, TomlValue> {
  let current = data;
  for (const segment of path.split(".")) {
    const existing = current[segment];
    if (!isTable(existing)) current[segment] = {};
    current = current[segment] as Record<string, TomlValue>;
  }
  return current;
}

function isTable(value: TomlValue | undefined): value is Record<string, TomlValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function cloneToml<T>(value: T): T {
  return structuredClone(value);
}
