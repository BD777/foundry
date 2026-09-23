#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const casesRoot = resolve(root, "cases");
const allowedKinds = new Set([
  "unit",
  "contract",
  "api",
  "daemon",
  "storage",
  "security",
  "browser-interaction",
  "browser-visual",
]);
const allowedRisks = new Set(["critical", "high", "medium", "low"]);
const allowedCadences = new Set([
  "commit",
  "pull-request",
  "release",
  "manual",
]);
const allowedStatuses = new Set(["automated", "manual", "planned"]);
const allowedActions = new Set([
  "navigate",
  "back",
  "click",
  "type",
  "select",
  "request",
  "run",
  "wait",
  "inspect",
]);
const allowedAssertionTypes = new Set([
  "visible",
  "hidden",
  "text",
  "url",
  "status",
  "json-shape",
  "command-exit-zero",
  "no-console-errors",
  "no-horizontal-overflow",
  "screenshot-match",
]);
const allowedRunners = new Set([
  "node-test",
  "go-test",
  "repo-script",
  "browser",
  "manual",
]);
const allowedEvidence = new Set([
  "response",
  "logs",
  "console",
  "network",
  "screenshot",
]);
const allowedRetentions = new Set(["failure", "always", "never"]);
const browserKinds = new Set(["browser-interaction", "browser-visual"]);
const keys = {
  assertion: new Set(["afterStep", "type", "target", "expected"]),
  automation: new Set(["status", "runner", "command", "references"]),
  environment: new Set([
    "baseUrl",
    "route",
    "fixture",
    "colorScheme",
    "viewport",
  ]),
  evidence: new Set(["capture", "retainOn"]),
  root: new Set([
    "version",
    "id",
    "title",
    "description",
    "kind",
    "area",
    "risk",
    "cadence",
    "tags",
    "preconditions",
    "environment",
    "steps",
    "assertions",
    "automation",
    "evidence",
    "visual",
    "cleanup",
  ]),
  step: new Set(["id", "action", "target", "value"]),
  viewport: new Set(["width", "height"]),
  visual: new Set(["baseline", "maxPixelDiffRatio", "masks"]),
};

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function pathFromReference(reference) {
  return reference.split("#", 1)[0];
}

function unknownKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

const casePaths = walk(casesRoot)
  .filter((path) => path.endsWith(".case.json"))
  .sort();
const failures = [];
const warnings = [];
const seenIds = new Map();
const counts = new Map();

for (const path of casePaths) {
  const label = relative(root, path);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${label}: invalid JSON (${error.message})`);
    continue;
  }

  const fail = (message) => failures.push(`${label}: ${message}`);
  for (const key of unknownKeys(value, keys.root)) fail(`unknown field ${key}`);
  if (value.version !== 1) fail("version must be 1");
  if (!isNonEmptyString(value.id)) fail("id is required");
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value.id ?? "")) {
    fail("id must be lowercase dot/dash notation");
  }
  if (seenIds.has(value.id)) {
    fail(`duplicates id from ${seenIds.get(value.id)}`);
  } else if (isNonEmptyString(value.id)) {
    seenIds.set(value.id, label);
  }
  if (!isNonEmptyString(value.title)) fail("title is required");
  if (!isNonEmptyString(value.description)) fail("description is required");
  if (!allowedKinds.has(value.kind)) fail(`unknown kind ${value.kind}`);
  if (!isNonEmptyString(value.area)) fail("area is required");
  if (!allowedRisks.has(value.risk)) fail(`unknown risk ${value.risk}`);
  if (
    !Array.isArray(value.cadence) ||
    value.cadence.length === 0 ||
    value.cadence.some((item) => !allowedCadences.has(item)) ||
    new Set(value.cadence).size !== value.cadence.length
  ) {
    fail("cadence must contain unique supported values");
  }
  if (value.tags !== undefined && !isStringArray(value.tags)) {
    fail("tags must contain non-empty strings");
  }
  if (!isStringArray(value.preconditions)) {
    fail("preconditions must contain non-empty strings");
  }
  if (!isStringArray(value.cleanup)) {
    fail("cleanup must contain non-empty strings");
  }

  if (value.environment !== undefined) {
    for (const key of unknownKeys(value.environment, keys.environment)) {
      fail(`unknown environment field ${key}`);
    }
    const viewport = value.environment?.viewport;
    if (viewport !== undefined) {
      for (const key of unknownKeys(viewport, keys.viewport)) {
        fail(`unknown viewport field ${key}`);
      }
      if (
        !Number.isInteger(viewport.width) ||
        viewport.width < 320 ||
        !Number.isInteger(viewport.height) ||
        viewport.height < 480
      ) {
        fail("viewport requires integer width >= 320 and height >= 480");
      }
    }
  }

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    fail("at least one step is required");
  }
  const stepIds = new Set();
  for (const step of value.steps ?? []) {
    for (const key of unknownKeys(step, keys.step)) {
      fail(`step ${step.id ?? "<unknown>"} has unknown field ${key}`);
    }
    if (!isNonEmptyString(step.id)) fail("every step needs an id");
    if (stepIds.has(step.id)) fail(`duplicate step id ${step.id}`);
    stepIds.add(step.id);
    if (!allowedActions.has(step.action)) {
      fail(`step ${step.id} has unsupported action ${step.action}`);
    }
    if (!isNonEmptyString(step.target)) fail(`step ${step.id} needs a target`);
    if (
      browserKinds.has(value.kind) &&
      /(^|[\s>])(?:\.|#)[A-Za-z_-]|\.fdy-/.test(step.target ?? "")
    ) {
      fail(
        `step ${step.id} uses a CSS selector; use a role, label, or visible text`,
      );
    }
  }

  if (!Array.isArray(value.assertions) || value.assertions.length === 0) {
    fail("at least one assertion is required");
  }
  for (const assertion of value.assertions ?? []) {
    for (const key of unknownKeys(assertion, keys.assertion)) {
      fail(
        `assertion after ${assertion.afterStep ?? "<unknown>"} has unknown field ${key}`,
      );
    }
    if (!stepIds.has(assertion.afterStep)) {
      fail(`assertion references unknown step ${assertion.afterStep}`);
    }
    if (!allowedAssertionTypes.has(assertion.type)) {
      fail(`unsupported assertion type ${assertion.type}`);
    }
    if (!isNonEmptyString(assertion.target))
      fail("assertion target is required");
  }

  if (!value.automation || typeof value.automation !== "object") {
    fail("automation is required");
  } else {
    for (const key of unknownKeys(value.automation, keys.automation)) {
      fail(`unknown automation field ${key}`);
    }
    if (!allowedStatuses.has(value.automation.status)) {
      fail(`unknown automation status ${value.automation.status}`);
    }
    if (!allowedRunners.has(value.automation.runner)) {
      fail(`unknown automation runner ${value.automation.runner}`);
    }
    if (
      browserKinds.has(value.kind) &&
      !["browser", "manual"].includes(value.automation.runner)
    ) {
      fail("browser cases require the browser or manual runner");
    }
    if (
      value.automation.status === "automated" &&
      !isNonEmptyString(value.automation.command)
    ) {
      fail("automated cases require a command");
    }
    if (!Array.isArray(value.automation.references)) {
      fail("automation.references must be an array");
    }
    for (const reference of value.automation.references ?? []) {
      if (!isNonEmptyString(reference)) {
        fail("automation references cannot be empty");
        continue;
      }
      const referencedPath = resolve(root, pathFromReference(reference));
      if (!existsSync(referencedPath)) {
        fail(`automation reference does not exist: ${reference}`);
      }
    }
  }

  if (!value.evidence || typeof value.evidence !== "object") {
    fail("evidence is required");
  } else {
    for (const key of unknownKeys(value.evidence, keys.evidence)) {
      fail(`unknown evidence field ${key}`);
    }
    if (
      !Array.isArray(value.evidence.capture) ||
      value.evidence.capture.some((item) => !allowedEvidence.has(item)) ||
      new Set(value.evidence.capture).size !== value.evidence.capture.length
    ) {
      fail("evidence.capture must contain unique supported values");
    }
    if (!allowedRetentions.has(value.evidence.retainOn)) {
      fail(`unknown evidence retention ${value.evidence.retainOn}`);
    }
  }
  if (value.kind === "browser-visual") {
    if (!value.environment?.viewport) fail("visual cases require a viewport");
    if (!value.evidence?.capture?.includes("screenshot")) {
      fail("visual cases must capture a screenshot");
    }
    for (const key of unknownKeys(value.visual, keys.visual)) {
      fail(`unknown visual field ${key}`);
    }
    if (!isNonEmptyString(value.visual?.baseline)) {
      fail("visual cases require a baseline name");
    }
    if (
      typeof value.visual?.maxPixelDiffRatio !== "number" ||
      value.visual.maxPixelDiffRatio < 0 ||
      value.visual.maxPixelDiffRatio > 1
    ) {
      fail("visual maxPixelDiffRatio must be between 0 and 1");
    }
    if (!isStringArray(value.visual?.masks)) {
      fail("visual masks must contain non-empty semantic targets");
    }
  } else if (value.visual !== undefined) {
    fail("visual settings are only valid for browser-visual cases");
  }

  if (
    ["critical", "high"].includes(value.risk) &&
    value.automation?.status !== "automated"
  ) {
    warnings.push(`${label}: ${value.risk}-risk case is not automated yet`);
  }

  const key = `${value.kind}/${value.automation?.status ?? "invalid"}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

if (casePaths.length === 0) failures.push("no regression cases found");

if (failures.length > 0) {
  console.error("Regression case validation failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const summary = [...counts.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, count]) => `${key}=${count}`)
  .join(", ");
console.log(`Regression cases valid: ${casePaths.length} (${summary}).`);
for (const warning of warnings)
  console.warn(`Case coverage warning: ${warning}`);
