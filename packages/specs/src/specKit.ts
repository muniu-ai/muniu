import path from "node:path";
import { canonicalJson, digestSpecRevision } from "./canonical.js";
import {
  assertSafeSpecSetId,
  atomicWriteText,
  readOptionalText
} from "./fileUtils.js";
import type {
  AcceptanceCase,
  AcceptanceKind,
  SpecContracts,
  SpecKitImportOptions,
  SpecRevision
} from "./types.js";
import { validateSpecRevision } from "./validation.js";

interface MarkdownSection {
  level: number;
  title: string;
  normalizedTitle: string;
  body: string[];
}

interface SpecKitInteropMetadata {
  title?: SpecRevision["title"];
  hypothesis?: SpecRevision["hypothesis"];
  outcomes?: SpecRevision["outcomes"];
  nonGoals?: SpecRevision["nonGoals"];
  targetServices: SpecRevision["targetServices"];
  contracts: SpecRevision["contracts"];
  acceptanceCases: SpecRevision["acceptanceCases"];
  risks: SpecRevision["risks"];
  unknowns: SpecRevision["unknowns"];
}

const INTEROP_METADATA_FIELDS = new Set([
  "title",
  "hypothesis",
  "outcomes",
  "nonGoals",
  "targetServices",
  "contracts",
  "acceptanceCases",
  "risks",
  "unknowns"
]);

function normalizeHeading(value: string): string {
  return value
    .trim()
    .replace(/#+$/u, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function markdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/u);
  const headings: Array<{ index: number; level: number; title: string }> = [];
  lines.forEach((line, index) => {
    const match = /^(#{2,6})\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] && match[2]) {
      headings.push({ index, level: match[1].length, title: match[2] });
    }
  });

  return headings.map((heading) => {
    const next = headings.find(
      (candidate) =>
        candidate.index > heading.index && candidate.level <= heading.level
    );
    return {
      level: heading.level,
      title: heading.title,
      normalizedTitle: normalizeHeading(heading.title),
      body: lines.slice(heading.index + 1, next?.index ?? lines.length)
    };
  });
}

function findSection(
  sections: MarkdownSection[],
  candidates: string[]
): MarkdownSection | undefined {
  const normalizedCandidates = new Set(candidates.map(normalizeHeading));
  return sections.find(
    (section) =>
      section.level === 2 &&
      [...normalizedCandidates].some(
        (candidate) =>
          section.normalizedTitle === candidate ||
          section.normalizedTitle.startsWith(`${candidate} `)
      )
  );
}

function cleanMarkdownText(value: string): string {
  return value
    .trim()
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/^\*|\*$/gu, "")
    .trim();
}

function bulletItems(lines: string[]): string[] {
  return lines
    .map((line) => {
      const match = /^\s*(?:[-*+] |\d+\.\s+)(?:\[[ xX]\]\s*)?(.+?)\s*$/u.exec(
        line
      );
      return match?.[1] ? cleanMarkdownText(match[1]) : undefined;
    })
    .filter((item): item is string => item !== undefined && item.length > 0);
}

function firstParagraph(lines: string[]): string | undefined {
  const paragraph: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (started) {
        break;
      }
      continue;
    }
    if (/^(?:[-*+] |\d+\.\s+)/u.test(trimmed)) {
      if (started) {
        break;
      }
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed) || /^\*\*[^*]+\*\*\s*:/u.test(trimmed)) {
      if (started) {
        break;
      }
      continue;
    }
    started = true;
    paragraph.push(cleanMarkdownText(trimmed));
  }
  return paragraph.length > 0 ? paragraph.join(" ") : undefined;
}

function extractInputDescription(markdown: string): string | undefined {
  const input = /^\s*\*\*Input\*\*\s*:\s*(?:User description\s*:\s*)?(.+?)\s*$/imu.exec(
    markdown
  )?.[1];
  if (!input) {
    return undefined;
  }
  return cleanMarkdownText(input).replace(/^["“]|["”]$/gu, "").trim();
}

function extractTitle(markdown: string): string {
  const title = /^#\s+(.+?)\s*$/mu.exec(markdown)?.[1];
  if (!title || title.trim().length === 0) {
    throw new TypeError("Spec Kit spec.md must contain an H1 title");
  }
  return cleanMarkdownText(title);
}

function acceptanceKindFromText(value: string): AcceptanceKind {
  if (
    /\b(?:boundary|empty|missing|unknown|duplicate|concurrent|timeout|partial|historical)\b/iu.test(
      value
    )
  ) {
    return "boundary";
  }
  if (
    /\b(?:reject|denied|deny|invalid|unauthori[sz]ed|forbidden|error|fail)\b/iu.test(
      value
    )
  ) {
    return "negative";
  }
  return "positive";
}

function acceptanceId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64);
  return `accept-${slug || "scenario"}-${index + 1}`;
}

function checkboxAcceptance(markdown: string): AcceptanceCase[] {
  const titles = markdown
    .split(/\r?\n/u)
    .map((line) => /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/u.exec(line)?.[1])
    .filter((title): title is string => title !== undefined);
  return titles.map((title, index) => ({
    id: acceptanceId(title, index),
    kind: acceptanceKindFromText(title),
    title: cleanMarkdownText(title),
    given: ["The imported Spec Kit context applies."],
    when: "The increment is implemented.",
    then: [cleanMarkdownText(title)]
  }));
}

function scenarioAcceptance(
  sections: MarkdownSection[],
  offset: number
): AcceptanceCase[] {
  return sections
    .filter((section) => /^scenario\b/iu.test(section.title.trim()))
    .map((section, index) => {
      const title = cleanMarkdownText(
        section.title.replace(/^scenario\s*:?\s*/iu, "")
      );
      const given: string[] = [];
      const then: string[] = [];
      let when = "The scenario action occurs.";
      let explicitKind: AcceptanceKind | undefined;

      for (const line of section.body) {
        const kindMatch = /^\s*(?:[-*+]\s*)?\*{0,2}kind\*{0,2}\s*:\s*(positive|negative|boundary)\s*$/iu.exec(
          line
        );
        if (kindMatch?.[1]) {
          explicitKind = kindMatch[1].toLowerCase() as AcceptanceKind;
          continue;
        }
        const stepMatch = /^\s*(?:[-*+]\s*)?\*{0,2}(given|when|then)\*{0,2}\s*:\s*(.+?)\s*$/iu.exec(
          line
        );
        if (!stepMatch?.[1] || !stepMatch[2]) {
          continue;
        }
        const step = stepMatch[1].toLowerCase();
        const text = cleanMarkdownText(stepMatch[2]);
        if (step === "given") {
          given.push(text);
        } else if (step === "when") {
          when = text;
        } else {
          then.push(text);
        }
      }

      return {
        id: acceptanceId(title, offset + index),
        kind: explicitKind ?? acceptanceKindFromText(`${title} ${then.join(" ")}`),
        title,
        given:
          given.length > 0
            ? given
            : ["The imported Spec Kit context applies."],
        when,
        then: then.length > 0 ? then : [title]
      };
    });
}

function inlineScenarioAcceptance(
  markdown: string,
  offset: number
): AcceptanceCase[] {
  const scenarios: AcceptanceCase[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const match = /^\s*\d+\.\s+\*{0,2}Given\*{0,2}\s*:?\s*(.+?),\s*\*{0,2}When\*{0,2}\s*:?\s*(.+?),\s*\*{0,2}Then\*{0,2}\s*:?\s*(.+?)\s*$/iu.exec(
      line
    );
    if (!match?.[1] || !match[2] || !match[3]) {
      continue;
    }
    const given = cleanMarkdownText(match[1]);
    const when = cleanMarkdownText(match[2]);
    const then = cleanMarkdownText(match[3]);
    const index = offset + scenarios.length;
    scenarios.push({
      id: acceptanceId(then, index),
      kind: acceptanceKindFromText(`${given} ${when} ${then}`),
      title: then.replace(/[.]$/u, ""),
      given: [given],
      when,
      then: [then]
    });
  }
  return scenarios;
}

function edgeCaseAcceptance(
  sections: MarkdownSection[],
  offset: number
): AcceptanceCase[] {
  const edgeCases = sections
    .filter(
      (section) =>
        section.normalizedTitle === "edge cases" ||
        section.normalizedTitle.startsWith("edge cases ")
    )
    .flatMap((section) => bulletItems(section.body));
  return edgeCases.map((edgeCase, index) => ({
    id: acceptanceId(edgeCase, offset + index),
    kind: "boundary",
    title: edgeCase,
    given: ["The imported Spec Kit context applies."],
    when: edgeCase,
    then: [edgeCase]
  }));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function validateImportedRevision(revision: SpecRevision): SpecRevision {
  const validation = validateSpecRevision(revision);
  if (!validation.valid) {
    throw new TypeError(
      `Invalid imported Spec Kit revision: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return deepFreeze(revision);
}

function parseInteropMetadata(
  planMarkdown: string | undefined
): SpecKitInteropMetadata | undefined {
  if (!planMarkdown) return undefined;
  const interopHeadings = [
    ...planMarkdown.matchAll(/^##\s+MN Interop Metadata[^\r\n]*$/gimu)
  ];
  if (interopHeadings.length > 1) {
    throw new TypeError(
      "Spec Kit plan.md must contain at most one MN Interop Metadata section"
    );
  }
  const hasInteropHeading = interopHeadings.length === 1;
  const json = /##\s+MN Interop Metadata[^\r\n]*\r?\n(?:[ \t]*\r?\n)*^(`{3,})json[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/imu.exec(
    planMarkdown
  )?.[2];
  if (!json) {
    if (hasInteropHeading) {
      throw new TypeError(
        "Spec Kit MN Interop Metadata heading requires a closed JSON fence"
      );
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
    canonicalJson(parsed);
  } catch (error) {
    throw new TypeError("Spec Kit MN Interop Metadata must be canonical JSON", {
      cause: error
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Spec Kit MN Interop Metadata must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((field) => !INTEROP_METADATA_FIELDS.has(field)) ||
    (record.title !== undefined && typeof record.title !== "string") ||
    (record.hypothesis !== undefined && typeof record.hypothesis !== "string") ||
    (record.outcomes !== undefined && !Array.isArray(record.outcomes)) ||
    (record.nonGoals !== undefined && !Array.isArray(record.nonGoals)) ||
    !Array.isArray(record.targetServices) ||
    !Array.isArray(record.acceptanceCases) ||
    !Array.isArray(record.risks) ||
    !Array.isArray(record.unknowns) ||
    record.contracts === null ||
    typeof record.contracts !== "object" ||
    Array.isArray(record.contracts)
  ) {
    throw new TypeError("Spec Kit MN Interop Metadata has an invalid shape");
  }
  return JSON.parse(canonicalJson(parsed)) as SpecKitInteropMetadata;
}

function normalizedDisplay(value: string): string {
  return cleanMarkdownText(value).replace(/\s+/gu, " ").trim();
}

function assertInteropMatchesSpecMarkdown(
  interop: SpecKitInteropMetadata,
  markdown: {
    title: string;
    hypothesis: string;
    outcomes: string[];
    nonGoals: string[];
    acceptanceCases: AcceptanceCase[];
  }
): void {
  const normalizeList = (values: readonly string[]): string[] =>
    values.map(normalizedDisplay);
  const normalizeAcceptance = (acceptance: AcceptanceCase) => ({
    title: normalizedDisplay(acceptance.title),
    kind: acceptance.kind,
    given: normalizeList(acceptance.given),
    when: normalizedDisplay(acceptance.when),
    then: normalizeList(acceptance.then)
  });
  const projectionsMatch =
    (interop.title === undefined ||
      normalizedDisplay(interop.title) === normalizedDisplay(markdown.title)) &&
    (interop.hypothesis === undefined ||
      normalizedDisplay(interop.hypothesis) ===
        normalizedDisplay(markdown.hypothesis)) &&
    (interop.outcomes === undefined ||
      canonicalJson(normalizeList(interop.outcomes)) ===
        canonicalJson(normalizeList(markdown.outcomes))) &&
    (interop.nonGoals === undefined ||
      canonicalJson(normalizeList(interop.nonGoals)) ===
        canonicalJson(normalizeList(markdown.nonGoals))) &&
    canonicalJson(interop.acceptanceCases.map(normalizeAcceptance)) ===
      canonicalJson(markdown.acceptanceCases.map(normalizeAcceptance));
  if (!projectionsMatch) {
    throw new TypeError(
      "Spec Kit spec.md has drifted from MN Interop Metadata; refresh or remove the stale metadata before import"
    );
  }
}

function restoreAcceptanceIdentity(
  parsed: AcceptanceCase[],
  interop: readonly AcceptanceCase[] | undefined
): AcceptanceCase[] {
  if (!interop || interop.length !== parsed.length) return parsed;
  return parsed.map((acceptance, index) => {
    const stored = interop[index];
    if (!stored || stored.title !== acceptance.title) return acceptance;
    return {
      ...acceptance,
      id: stored.id,
      ...(stored.targetService === undefined
        ? {}
        : { targetService: stored.targetService })
    };
  });
}

export async function importSpecKitDirectory(
  directory: string,
  options: SpecKitImportOptions = {}
): Promise<SpecRevision> {
  const specMarkdown = await readOptionalText(path.join(directory, "spec.md"));
  if (specMarkdown === undefined) {
    throw new Error("Spec Kit directory must contain spec.md");
  }
  const [planMarkdown, tasksMarkdown] = await Promise.all([
    readOptionalText(path.join(directory, "plan.md")),
    readOptionalText(path.join(directory, "tasks.md"))
  ]);
  const interopMetadata = parseInteropMetadata(planMarkdown);
  const sections = markdownSections(specMarkdown);
  const markdownTitle = extractTitle(specMarkdown);
  const goalSection = findSection(sections, [
    "Goal",
    "Goals",
    "Overview",
    "Summary",
    "Problem Statement",
    "Purpose"
  ]);
  const markdownHypothesis =
    (goalSection && firstParagraph(goalSection.body)) ??
    extractInputDescription(specMarkdown) ??
    firstParagraph(specMarkdown.split(/\r?\n/u).slice(1));
  if (!markdownHypothesis) {
    throw new TypeError("Spec Kit spec.md must describe a goal");
  }

  const successSection = findSection(sections, [
    "Success Criteria",
    "Outcomes",
    "Objectives"
  ]);
  const markdownOutcomes = successSection ? bulletItems(successSection.body) : [];
  const nonGoalSection = findSection(sections, [
    "Out of Scope",
    "Non Goals",
    "Non-Goals"
  ]);
  const markdownNonGoals = nonGoalSection ? bulletItems(nonGoalSection.body) : [];

  const checkboxCases = checkboxAcceptance(specMarkdown);
  const inlineCases = inlineScenarioAcceptance(
    specMarkdown,
    checkboxCases.length
  );
  const scenarioCases = scenarioAcceptance(
    sections,
    checkboxCases.length + inlineCases.length
  );
  const edgeCases = edgeCaseAcceptance(
    sections,
    checkboxCases.length + inlineCases.length + scenarioCases.length
  );
  const parsedMarkdownAcceptanceCases = [
    ...checkboxCases,
    ...inlineCases,
    ...scenarioCases,
    ...edgeCases
  ];
  if (interopMetadata !== undefined) {
    assertInteropMatchesSpecMarkdown(interopMetadata, {
      title: markdownTitle,
      hypothesis: markdownHypothesis,
      outcomes: markdownOutcomes,
      nonGoals: markdownNonGoals,
      acceptanceCases: parsedMarkdownAcceptanceCases
    });
  }
  const parsedAcceptanceCases = restoreAcceptanceIdentity(
    parsedMarkdownAcceptanceCases,
    interopMetadata?.acceptanceCases
  );
  const title = interopMetadata?.title ?? markdownTitle;
  const hypothesis = interopMetadata?.hypothesis ?? markdownHypothesis;
  const outcomes = interopMetadata?.outcomes
    ? [...interopMetadata.outcomes]
    : markdownOutcomes;
  const nonGoals = interopMetadata?.nonGoals
    ? [...interopMetadata.nonGoals]
    : markdownNonGoals;
  const acceptanceCases = interopMetadata?.acceptanceCases
    ? interopMetadata.acceptanceCases.map((acceptance) => ({ ...acceptance }))
    : parsedAcceptanceCases;
  const effectiveOutcomes = outcomes.length > 0 ? outcomes : [hypothesis];
  if (acceptanceCases.length === 0) {
    effectiveOutcomes.forEach((outcome, index) => {
      acceptanceCases.push({
        id: acceptanceId(outcome, index),
        kind: "positive",
        title: outcome,
        given: ["The imported Spec Kit context applies."],
        when: "The increment is implemented.",
        then: [outcome]
      });
    });
  }

  const sourceMetadata = {
    specMd: specMarkdown,
    ...(planMarkdown === undefined ? {} : { planMd: planMarkdown }),
    ...(tasksMarkdown === undefined ? {} : { tasksMd: tasksMarkdown })
  };
  const contracts: SpecContracts = interopMetadata?.contracts ?? {
    interface: {},
    data: {},
    state: {},
    permission: {},
    exception: {},
    quality: {},
    observability: {},
    metadata: { specKit: sourceMetadata }
  };
  const specSetId = options.specSetId ?? path.basename(path.resolve(directory));
  assertSafeSpecSetId(specSetId);
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId,
    revision: options.revision ?? 1,
    status: "draft",
    source: "spec-kit",
    title,
    hypothesis,
    outcomes: effectiveOutcomes,
    nonGoals:
      nonGoals.length > 0
        ? nonGoals
        : ["Do not infer scope beyond the imported Spec Kit specification."],
    targetServices: [
      ...(options.targetServices ?? interopMetadata?.targetServices ?? [])
    ],
    contracts,
    acceptanceCases,
    risks: [...(interopMetadata?.risks ?? [])],
    unknowns: [...(interopMetadata?.unknowns ?? [])],
    createdAt: options.createdAt ?? new Date().toISOString(),
    createdBy: options.createdBy?.trim() || "spec-kit-adapter"
  };
  return validateImportedRevision({
    ...unsigned,
    digest: digestSpecRevision(unsigned)
  });
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function markdownFence(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/gu)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function renderSpecMarkdown(revision: SpecRevision): string {
  const lines = [
    `# ${singleLine(revision.title)}`,
    "",
    "## Goal",
    "",
    singleLine(revision.hypothesis),
    "",
    "## Success Criteria",
    "",
    ...revision.outcomes.map((outcome) => `- ${singleLine(outcome)}`),
    "",
    "## Out of Scope",
    "",
    ...revision.nonGoals.map((nonGoal) => `- ${singleLine(nonGoal)}`),
    "",
    "## Acceptance Scenarios",
    ""
  ];
  revision.acceptanceCases.forEach((acceptance) => {
    lines.push(
      `### Scenario: ${singleLine(acceptance.title)}`,
      `**Kind:** ${acceptance.kind}`,
      ...acceptance.given.map((given) => `- Given: ${singleLine(given)}`),
      `- When: ${singleLine(acceptance.when)}`,
      ...acceptance.then.map((then) => `- Then: ${singleLine(then)}`),
      ""
    );
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderPlanMarkdown(revision: SpecRevision): string {
  const { metadata: _metadata, ...contracts } = revision.contracts;
  const contractJson = JSON.stringify(
    JSON.parse(canonicalJson(contracts)) as unknown,
    null,
    2
  );
  const services =
    revision.targetServices.length > 0
      ? revision.targetServices.map((service) => `- ${singleLine(service)}`)
      : ["- No target service declared."];
  const interopJson = JSON.stringify(
    JSON.parse(
      canonicalJson({
        title: revision.title,
        hypothesis: revision.hypothesis,
        outcomes: revision.outcomes,
        nonGoals: revision.nonGoals,
        targetServices: revision.targetServices,
        contracts: revision.contracts,
        acceptanceCases: revision.acceptanceCases,
        risks: revision.risks,
        unknowns: revision.unknowns
      })
    ) as unknown,
    null,
    2
  );
  const contractFence = markdownFence(contractJson);
  const interopFence = markdownFence(interopJson);
  return `${[
    `# Implementation Plan: ${singleLine(revision.title)}`,
    "",
    "## Target Services",
    "",
    ...services,
    "",
    "## Contract Snapshot",
    "",
    `${contractFence}json`,
    contractJson,
    contractFence,
    "",
    "## MN Interop Metadata",
    "",
    `${interopFence}json`,
    interopJson,
    interopFence,
    ""
  ].join("\n")}`;
}

function renderTasksMarkdown(revision: SpecRevision): string {
  return `${[
    `# Tasks: ${singleLine(revision.title)}`,
    "",
    ...revision.acceptanceCases.map(
      (acceptance) =>
        `- [ ] [${acceptance.id}] ${singleLine(acceptance.title)} (${acceptance.kind})`
    ),
    ""
  ].join("\n")}`;
}

export async function exportSpecKitDirectory(
  directory: string,
  revision: SpecRevision
): Promise<void> {
  const validation = validateSpecRevision(revision);
  if (!validation.valid) {
    throw new TypeError("Cannot export an invalid Spec revision");
  }
  await Promise.all([
    atomicWriteText(path.join(directory, "spec.md"), renderSpecMarkdown(revision)),
    atomicWriteText(path.join(directory, "plan.md"), renderPlanMarkdown(revision)),
    atomicWriteText(path.join(directory, "tasks.md"), renderTasksMarkdown(revision))
  ]);
}
