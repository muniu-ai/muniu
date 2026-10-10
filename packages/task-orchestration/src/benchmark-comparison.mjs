// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
const TASKS_SHA256 = '6fdca35ff19986b7b27eeac103c63820717cd2cdb652f9d82581263120b5f9a3';
const CONTROLS_SHA256 = '9c901ff0c5c2f3ec281fd7a205a7d4c491d10b05a21a9965b113a1c4fcc3340a';
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const INTEGER = /^(0|[1-9][0-9]*)$/u;
const ensure = (condition, code) => { if (!condition) throw new Error(code); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

function exactSet(actual, expected, code) {
  ensure(Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === actual.length
    && actual.every(id => expected.includes(id)), code);
}

export function validateBenchmark(corpus) {
  const { manifest, tasks, controls } = corpus;
  ensure(manifest?.schemaVersion === 1 && manifest.id === 'muniu-agent-os-delivery' && manifest.version === '1.0.0', 'INVALID_MANIFEST');
  ensure(manifest.measurementStatus === 'not_measured' && manifest.license === 'Apache-2.0', 'INVALID_MANIFEST');
  ensure(manifest.frozenAt === '2026-10-10T00:00:00.000Z'
    && canonical(manifest.counts) === canonical({ total: 60, development: 40, holdout: 20, business: 20, research: 20, coding: 20 }), 'INVALID_MANIFEST');
  ensure(manifest.tasksSha256 === TASKS_SHA256 && digest(tasks) === TASKS_SHA256, 'TASKS_DIGEST_MISMATCH');
  ensure(manifest.controlsSha256 === CONTROLS_SHA256 && digest(controls) === CONTROLS_SHA256, 'CONTROLS_DIGEST_MISMATCH');
  ensure(tasks.length === 60 && tasks.filter(task => task.split === 'development').length === 40
    && tasks.filter(task => task.split === 'holdout').length === 20, 'INVALID_SPLIT');
  for (const domain of ['business', 'research', 'coding']) ensure(tasks.filter(task => task.domain === domain).length === 20, 'INVALID_DOMAIN_COUNT');
  ensure(new Set(tasks.map(task => task.id)).size === 60 && new Set(tasks.map(task => task.input.request)).size === 60, 'DUPLICATE_TASK');
  for (const task of tasks) {
    ensure(task.synthetic === true && nonempty(task.title) && nonempty(task.input.request) && nonempty(task.expectedOutput), 'INVALID_TASK');
    ensure(task.input.documents.length > 0 && task.input.documents.every(doc => nonempty(doc.id) && nonempty(doc.version) && nonempty(doc.content)), 'INVALID_MATERIAL');
    ensure(task.input.authorization.externalSideEffects === 'forbidden' && task.input.authorization.network === 'disabled', 'UNSAFE_FIXTURE');
    ensure(task.acceptance.length >= 3 && task.safety.length >= 2 && [...task.acceptance, ...task.safety].every(check => nonempty(check.id) && nonempty(check.criterion)), 'INVALID_RUBRIC');
  }
  ensure(controls.length === 15 && new Set(controls.map(control => control.id)).size === 15, 'INVALID_CONTROLS');
  return corpus;
}


function validateEvidence(value) {
  ensure(object(value) && SHA256.test(value.artifactSha256) && ['human', 'deterministic'].includes(value.method), 'INVALID_EVIDENCE');
  ensure(value.method === 'human' ? nonempty(value.reviewer) : nonempty(value.check), 'INVALID_EVIDENCE');
}

function assess(actual, required) {
  exactSet(actual?.map(item => item?.id), required.map(item => item.id), 'ASSESSMENT_SET_MISMATCH');
  for (const item of actual) { ensure(typeof item.passed === 'boolean', 'INVALID_ASSESSMENT'); validateEvidence(item.evidence); }
  return actual.every(item => item.passed);
}

function validateMeasurement(result) {
  const { cost, humanTime } = result;
  ensure(object(cost) && ['known', 'unknown'].includes(cost.status), 'INVALID_COST');
  if (cost.status === 'unknown') {
    ensure(!('minorUnits' in cost) && !('currency' in cost), 'UNKNOWN_COST_HAS_AMOUNT');
    ensure(nonempty(cost.reason), 'UNKNOWN_COST_REASON_REQUIRED');
  } else {
    ensure(typeof cost.minorUnits === 'string' && INTEGER.test(cost.minorUnits) && cost.minorUnits.length <= 30 && /^[A-Z]{3}$/u.test(cost.currency), 'INVALID_COST');
    validateEvidence(cost.evidence);
  }
  ensure(object(humanTime) && ['known', 'unknown'].includes(humanTime.status), 'INVALID_HUMAN_TIME');
  if (humanTime.status === 'unknown') {
    ensure(!('milliseconds' in humanTime), 'UNKNOWN_TIME_HAS_VALUE');
    ensure(nonempty(humanTime.reason), 'UNKNOWN_TIME_REASON_REQUIRED');
  } else {
    ensure(Number.isSafeInteger(humanTime.milliseconds) && humanTime.milliseconds >= 0, 'INVALID_HUMAN_TIME');
    validateEvidence(humanTime.evidence);
  }
}

function rejectCredentials(value) {
  if (!object(value) && !Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    ensure(!/^(api.?key|access.?token|authorization|password|secret|credentials)$/iu.test(key), 'CREDENTIAL_IN_REPORT');
    rejectCredentials(child);
  }
}

function validateConfiguration(configuration, corpus) {
  ensure(object(configuration) && object(configuration.model) && object(configuration.model.parameters) && object(configuration.budget), 'INVALID_CONFIGURATION');
  const { model, budget } = configuration;
  ensure([model.provider, model.name, model.revision].every(nonempty) && !['latest', 'default', 'auto'].includes(model.revision), 'INVALID_CONFIGURATION');
  ensure(Number.isFinite(model.parameters.temperature) && model.parameters.temperature >= 0 && model.parameters.temperature <= 2, 'INVALID_CONFIGURATION');
  ensure(SHA256.test(configuration.promptSha256) && SHA256.test(configuration.policySha256), 'INVALID_CONFIGURATION');
  ensure(configuration.materialsSha256 === corpus.manifest.tasksSha256, 'MATERIALS_MISMATCH');
  ensure(budget.revision === 'budget-v1' && Number.isSafeInteger(budget.maxTokens) && budget.maxTokens > 0
    && typeof budget.maxCostMinorUnits === 'string' && INTEGER.test(budget.maxCostMinorUnits)
    && budget.maxCostMinorUnits.length <= 30 && /^[A-Z]{3}$/u.test(budget.currency), 'INVALID_CONFIGURATION');
}

function comparison(baseline, candidate, field) {
  const both = [...baseline.results, ...candidate.results];
  const unknownResults = both.filter(result => result[field].status === 'unknown').length;
  const currencies = field === 'cost' ? [...new Set(both.filter(result => result.cost.status === 'known').map(result => result.cost.currency))] : [];
  if (unknownResults || (field === 'cost' && currencies.length !== 1)) return {
    status: 'not_comparable', unknownResults, ...(field === 'cost' ? { currencies } : {}),
    reason: unknownResults ? 'UNKNOWN_MEASUREMENTS' : 'CURRENCY_MISMATCH', meetsThreshold: false,
  };
  if (!baseline.accepted || !candidate.accepted) return { status: 'not_comparable', reason: 'NO_ACCEPTED_OUTPUTS', unknownResults: 0, meetsThreshold: false };
  const value = result => BigInt(field === 'cost' ? result.cost.minorUnits : result.humanTime.milliseconds);
  const sum = results => results.reduce((total, result) => total + value(result), 0n);
  const baselineTotal = sum(baseline.results); const candidateTotal = sum(candidate.results);
  const base = baselineTotal * BigInt(candidate.accepted); const next = candidateTotal * BigInt(baseline.accepted);
  if (base === 0n) return { status: 'not_comparable', reason: 'ZERO_BASELINE', unknownResults: 0, meetsThreshold: false };
  const prefix = field === 'cost' ? 'MinorUnits' : 'Milliseconds';
  return {
    status: 'comparable', unknownResults: 0,
    ...(field === 'cost' ? { currency: currencies[0] } : {}),
    [`baseline${prefix}Total`]: baselineTotal.toString(), [`candidate${prefix}Total`]: candidateTotal.toString(),
    [`baseline${prefix}PerAccepted`]: Number(baselineTotal) / baseline.accepted,
    [`candidate${prefix}PerAccepted`]: Number(candidateTotal) / candidate.accepted,
    improvementPercent: Number((base - next) * 1000000n / base) / 10000,
    meetsThreshold: next * 5n <= base * 4n,
  };
}

export function compareReport(corpus, report) {
  validateBenchmark(corpus);
  ensure(object(report) && report.schemaVersion === 1 && report.datasetVersion === corpus.manifest.version && report.datasetSha256 === corpus.manifest.tasksSha256, 'DATASET_MISMATCH');
  rejectCredentials(report);
  if (report.executionMode === 'not_measured') {
    ensure(Array.isArray(report.arms) && report.arms.length === 0, 'UNMEASURED_REPORT_HAS_RESULTS');
    return { status: 'not_measured', releaseGate: 'not_evaluated', reason: 'NO_MEASURED_RESULTS' };
  }
  ensure(report.executionMode === 'measured', 'MEASURED_REPORT_REQUIRED');
  validateConfiguration(report.configuration, corpus);
  ensure(SHA256.test(report.configurationSha256) && report.configurationSha256 === digest(report.configuration), 'CONFIGURATION_MISMATCH');
  ensure(Array.isArray(report.tuningCaseIds) && new Set(report.tuningCaseIds).size === report.tuningCaseIds.length, 'INVALID_TUNING_CASE');
  for (const id of report.tuningCaseIds) {
    const task = corpus.tasks.find(item => item.id === id);
    ensure(task, 'INVALID_TUNING_CASE'); ensure(task.split === 'development', 'HOLDOUT_TUNING_FORBIDDEN');
  }
  exactSet(report.arms?.map(arm => arm?.arm), ['baseline', 'candidate'], 'ARM_SET_MISMATCH');
  const frozenAt = Date.parse(report.frozenAt);
  ensure(Number.isFinite(frozenAt) && frozenAt >= Date.parse(corpus.manifest.frozenAt), 'CONFIGURATION_NOT_FROZEN');
  const holdout = {}; let safetyPassed = true;
  const runIds = new Set();
  for (const arm of report.arms) {
    ensure(REVISION.test(arm.implementationRevision), 'IMPLEMENTATION_REVISION_REQUIRED');
    ensure(arm.configurationSha256 === report.configurationSha256, 'CONFIGURATION_MISMATCH');
    const controlsPassed = assess(arm.safetyRecovery, corpus.controls);
    safetyPassed = controlsPassed && safetyPassed;
    exactSet(arm.results?.map(result => result?.taskId), corpus.tasks.map(task => task.id), 'RESULT_SET_MISMATCH');
    const selected = []; let firstAccepted = 0; let accepted = 0;
    for (const result of arm.results) {
      const task = corpus.tasks.find(item => item.id === result.taskId);
      ensure(nonempty(result.runId) && !runIds.has(result.runId), 'INVALID_RUN_ID'); runIds.add(result.runId);
      ensure(Number.isFinite(Date.parse(result.startedAt)) && Date.parse(result.startedAt) >= frozenAt, 'CONFIGURATION_NOT_FROZEN');
      ensure(result.inputSha256 === digest(task.input), 'INPUT_MISMATCH');
      ensure(result.configurationSha256 === report.configurationSha256, 'CONFIGURATION_MISMATCH');
      const first = assess(result.firstAttempt, task.acceptance); const final = assess(result.finalAttempt, task.acceptance);
      const safe = assess(result.safety, task.safety); safetyPassed = safe && safetyPassed;
      validateMeasurement(result);
      if (task.split === 'holdout') { selected.push(result); firstAccepted += Number(first); accepted += Number(final); }
    }
    holdout[arm.arm] = { results: selected, count: selected.length, firstAccepted, accepted, firstAcceptanceRate: firstAccepted / selected.length };
  }
  const cost = comparison(holdout.baseline, holdout.candidate, 'cost');
  const humanTime = comparison(holdout.baseline, holdout.candidate, 'humanTime');
  const acceptanceNotRegressed = holdout.candidate.firstAccepted >= holdout.baseline.firstAccepted;
  const releaseGate = safetyPassed && acceptanceNotRegressed && (cost.meetsThreshold || humanTime.meetsThreshold) ? 'passed' : 'blocked';
  return {
    status: 'measured', releaseGate, safetyRecoveryPassed: safetyPassed, acceptanceNotRegressed,
    holdout: Object.fromEntries(Object.entries(holdout).map(([name, { results, ...summary }]) => [name, summary])), cost, humanTime,
  };
}
