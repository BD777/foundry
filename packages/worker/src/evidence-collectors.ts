import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CheckDefinition,
  CheckReport,
  Evidence,
  EvidenceClaim,
  Material,
  VerificationInput,
  Verdict,
} from "@foundry/protocol";
import { validateEvidenceModel } from "@foundry/protocol";
import { EvidenceStore, digestObject } from "./evidence-store.js";
import { childPath, identifier } from "./execution-storage.js";
import {
  assertNonsecretDeclarations,
  redactEvidence,
} from "./evidence-redaction.js";

export interface CollectionResult {
  evidence: Evidence;
  materials: Material[];
  assertions?: CheckReport["assertions"];
  verdict?: Verdict;
  technicalError?: { code: string; message: string; retryable: boolean };
}
export interface CommandInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
export interface CommandOutput {
  stdout: Buffer;
  stderr: Buffer;
  exitCode?: number;
  outcome: "completed" | "failed" | "timed_out" | "canceled";
  complete: boolean;
  error?: string;
}
/** The supplied launcher MUST enforce candidate read-only and output-only writes. */
export type IsolatedCommandLauncher = (
  invocation: CommandInvocation,
) => Promise<CommandOutput>;

export async function captureProcess(
  invocation: CommandInvocation,
): Promise<CommandOutput> {
  return new Promise((resolveResult) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0,
      complete = true,
      outcome: CommandOutput["outcome"] = "completed",
      error: string | undefined;
    const stop = () => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const timer = setTimeout(() => {
      outcome = "timed_out";
      stop();
    }, invocation.timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) {
        complete = false;
        outcome = "failed";
        stop();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (e) => {
      error = e.message;
      outcome = "failed";
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal && outcome === "completed") {
        outcome = "failed";
        error = `Command terminated by ${signal}`;
      }
      resolveResult({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? undefined,
        outcome,
        complete,
        error,
      });
    });
  });
}

export async function collectCommand(options: {
  evidenceId?: string;
  checker: CheckDefinition;
  input: VerificationInput;
  claims: EvidenceClaim[];
  candidateDirectory: string;
  outputDirectory: string;
  store: EvidenceStore;
  launch: IsolatedCommandLauncher;
}): Promise<CollectionResult> {
  const { checker, input, claims, store } = options;
  if (checker.configuration.kind !== "command")
    throw new Error("command_checker_required");
  const config = checker.configuration;
  assertNonsecretDeclarations(config.environment);
  assertNonsecretDeclarations(
    Object.fromEntries(
      config.args.map((arg, index) => [`argument_${index}`, arg]),
    ),
  );
  if (config.secretBindings.length)
    throw new Error("credential_authorization_required");
  const bundle = store.readMaterial(config.checkerBundleMaterialId);
  // v1 bundles are UTF-8 JSON {files:{relativePath: utf8Content}}.
  const files = JSON.parse(bundle.toString()) as {
    files: Record<string, string>;
  };
  if (!files.files || typeof files.files !== "object")
    throw new Error("invalid_checker_bundle");
  const fixtures = config.fixtureMaterialIds.map((id) => store.getMaterial(id));
  const expected = digestObject({
    configuration: config,
    bundleDigest: store.getMaterial(config.checkerBundleMaterialId).digest,
    fixtureDigests: fixtures.map((m) => m.digest),
    timeoutMs: checker.timeoutMs,
  });
  if (checker.definitionDigest !== expected)
    throw new Error("checker_digest_mismatch");
  const bundleDirectory = resolve(options.outputDirectory, "checker");
  mkdirSync(bundleDirectory, { recursive: true, mode: 0o700 });
  for (const [path, content] of Object.entries(files.files)) {
    if (typeof content !== "string") throw new Error("invalid_checker_bundle");
    const target = childPath(bundleDirectory, path);
    mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(target, content, { flag: "wx", mode: 0o400 });
  }
  const fixtureDirectory = resolve(bundleDirectory, "fixtures");
  mkdirSync(fixtureDirectory, { recursive: true, mode: 0o700 });
  for (const fixture of fixtures) {
    writeFileSync(
      resolve(fixtureDirectory, identifier(fixture.id)),
      store.readMaterial(fixture.id),
      { flag: "wx", mode: 0o400 },
    );
  }
  const entrypoint = childPath(bundleDirectory, config.entrypoint);
  const cwd =
    config.cwdRelativePath === "."
      ? options.candidateDirectory
      : childPath(options.candidateDirectory, config.cwdRelativePath);
  const startedAt = new Date().toISOString();
  const parameters = store.sealMaterial(
    "Command parameters",
    "data",
    Buffer.from(
      JSON.stringify({
        executable: config.executable,
        args: [config.entrypoint, ...config.args],
        cwdRelativePath: config.cwdRelativePath,
        environment: config.environment,
        credentialVersions: [],
        checkerDigest: expected,
      }),
    ),
  );
  const output = await options.launch({
    executable: config.executable,
    args: [entrypoint, ...config.args],
    cwd,
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      ...config.environment,
      FOUNDRY_EVIDENCE_OUTPUT: options.outputDirectory,
      FOUNDRY_CHECK_FIXTURES: fixtureDirectory,
    },
    timeoutMs: checker.timeoutMs,
  });
  const safeOut = redactEvidence(output.stdout),
    safeErr = redactEvidence(output.stderr);
  const stdout = store.sealMaterial(
    "stdout",
    "text_log",
    safeOut.bytes,
    safeOut.redaction,
  );
  const stderr = store.sealMaterial(
    "stderr",
    "text_log",
    safeErr.bytes,
    safeErr.redaction,
  );
  const evidence: Evidence = {
    ...store.record("ev"),
    ...(options.evidenceId ? { id: options.evidenceId } : {}),
    title: "Command capture",
    description: checker.description,
    verificationInputId: input.id,
    claims,
    materials: [
      { materialId: stdout.id, role: "stdout" },
      { materialId: stderr.id, role: "stderr" },
    ],
    source: {
      kind: "tool_capture",
      producer: store.actor,
      deviceId: store.deviceId,
    },
    collection: {
      operation: "command",
      collectorName: "foundry-command",
      collectorVersion: "1",
      inputMaterialId: parameters.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome: output.outcome,
      exitCode: output.exitCode,
      completeness: output.complete ? "complete" : "truncated",
    },
    candidateBinding: "system_observed",
  };
  store.sealRecord("evidence", evidence, "Evidence");
  const result: CollectionResult = {
    evidence,
    materials: [parameters, stdout, stderr],
  };
  if (safeOut.redaction.status === "applied") {
    result.technicalError = {
      code: "redacted_assertions",
      message:
        "Sensitive assertion output was redacted; revise the checker to emit non-sensitive observations",
      retryable: false,
    };
    return result;
  }
  if (output.outcome !== "completed") {
    result.technicalError = {
      code: output.outcome,
      message: output.error ?? "Command did not complete",
      retryable: true,
    };
    return result;
  }
  let report: CheckReport;
  try {
    report = JSON.parse(output.stdout.toString());
    if (validateEvidenceModel("CheckReport", report).length)
      throw new Error("Invalid foundry-check/v1");
  } catch {
    result.technicalError = {
      code: "invalid_report",
      message: "Checker did not return foundry-check/v1 assertions",
      retryable: false,
    };
    return result;
  }
  if (
    report.assertions.length < config.minimumAssertions ||
    !report.assertions.length ||
    new Set(report.assertions.map((a) => a.id)).size !==
      report.assertions.length
  ) {
    result.technicalError = {
      code: "insufficient_assertions",
      message: "Checker returned zero, insufficient or duplicate assertions",
      retryable: false,
    };
    return result;
  }
  result.assertions = report.assertions;
  result.verdict =
    !config.expectedExitCodes.includes(output.exitCode ?? -1) ||
    report.assertions.some((a) => a.verdict === "fail")
      ? "fail"
      : report.assertions.some((a) => a.verdict === "inconclusive")
        ? "inconclusive"
        : "pass";
  return result;
}

/**
 * Runs the project's own command against the sealed candidate and keeps the
 * captured output as the evidence. The exit code decides the verdict, so no
 * agent has to be believed about whether the command passed.
 */
export async function collectProjectCommand(options: {
  evidenceId?: string;
  checker: CheckDefinition;
  input: VerificationInput;
  claims: EvidenceClaim[];
  candidateDirectory: string;
  outputDirectory: string;
  store: EvidenceStore;
  launch: IsolatedCommandLauncher;
}): Promise<CollectionResult> {
  const { checker, input, claims, store } = options;
  if (checker.configuration.kind !== "project_command")
    throw new Error("project_command_checker_required");
  const config = checker.configuration;
  assertNonsecretDeclarations(config.environment);
  assertNonsecretDeclarations(
    Object.fromEntries(
      [config.executable, ...config.args].map((value, index) => [
        `argument_${index}`,
        value,
      ]),
    ),
  );
  const expected = digestObject({
    configuration: config,
    timeoutMs: checker.timeoutMs,
  });
  if (checker.definitionDigest !== expected)
    throw new Error("checker_digest_mismatch");
  const cwd =
    config.cwdRelativePath === "."
      ? options.candidateDirectory
      : childPath(options.candidateDirectory, config.cwdRelativePath);
  const startedAt = new Date().toISOString();
  const parameters = store.sealMaterial(
    "Project command parameters",
    "data",
    Buffer.from(
      JSON.stringify({
        executable: config.executable,
        args: config.args,
        cwdRelativePath: config.cwdRelativePath,
        environment: config.environment,
        expectedExitCodes: config.expectedExitCodes,
        checkerDigest: expected,
      }),
    ),
  );
  const output = await options.launch({
    executable: config.executable,
    args: config.args,
    cwd,
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      ...config.environment,
      FOUNDRY_EVIDENCE_OUTPUT: options.outputDirectory,
    },
    timeoutMs: checker.timeoutMs,
  });
  const safeOut = redactEvidence(output.stdout),
    safeErr = redactEvidence(output.stderr);
  const stdout = store.sealMaterial(
    "stdout",
    "text_log",
    safeOut.bytes,
    safeOut.redaction,
  );
  const stderr = store.sealMaterial(
    "stderr",
    "text_log",
    safeErr.bytes,
    safeErr.redaction,
  );
  const evidence: Evidence = {
    ...store.record("ev"),
    ...(options.evidenceId ? { id: options.evidenceId } : {}),
    title: `${config.executable} ${config.args.join(" ")}`.trim(),
    description: checker.description,
    verificationInputId: input.id,
    claims,
    materials: [
      { materialId: stdout.id, role: "stdout" },
      { materialId: stderr.id, role: "stderr" },
    ],
    source: {
      kind: "tool_capture",
      producer: store.actor,
      deviceId: store.deviceId,
    },
    collection: {
      operation: "command",
      collectorName: "foundry-project-command",
      collectorVersion: "1",
      inputMaterialId: parameters.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome: output.outcome,
      exitCode: output.exitCode,
      completeness: output.complete ? "complete" : "truncated",
    },
    candidateBinding: "system_observed",
  };
  store.sealRecord("evidence", evidence, "Evidence");
  const result: CollectionResult = {
    evidence,
    materials: [parameters, stdout, stderr],
  };
  if (output.outcome !== "completed") {
    result.technicalError = {
      code: output.outcome,
      message: output.error ?? "Command did not complete",
      retryable: true,
    };
    return result;
  }
  const passed = config.expectedExitCodes.includes(output.exitCode ?? -1);
  result.assertions = [
    {
      id: "exit_code",
      expected: config.expectedExitCodes,
      observed: output.exitCode ?? null,
      verdict: passed ? "pass" : "fail",
    },
  ];
  result.verdict = passed ? "pass" : "fail";
  return result;
}

export async function collectHTTP(options: {
  evidenceId?: string;
  checker: CheckDefinition;
  input: VerificationInput;
  claims: EvidenceClaim[];
  targetURL: string;
  store: EvidenceStore;
  authorize: (method: string, url: URL) => Promise<void>;
}): Promise<CollectionResult> {
  const { checker, input, claims, store } = options;
  if (checker.configuration.kind !== "http")
    throw new Error("http_checker_required");
  const c = checker.configuration;
  assertNonsecretDeclarations(c.headers);
  if (c.secretBindings.length)
    throw new Error("credential_authorization_required");
  const target = input.targets.find((t) => t.name === c.targetName);
  if (
    !target ||
    target.bindingStatus !== "verified" ||
    target.build?.sourceCandidateSnapshotId !== input.candidateSnapshotId
  )
    throw new Error("input_unbound: service build does not match candidate");
  const expectedDigest = digestObject({
    configuration: c,
    bodyDigest: c.bodyMaterialId
      ? store.getMaterial(c.bodyMaterialId).digest
      : "",
    timeoutMs: checker.timeoutMs,
  });
  if (checker.definitionDigest !== expectedDigest)
    throw new Error("checker_digest_mismatch");
  assertNonsecretDeclarations(c.expectedHeaders);
  if (
    redactEvidence(
      Buffer.from(
        JSON.stringify({
          path: c.path,
          expectedJsonValues: c.expectedJsonValues,
        }),
      ),
    ).redaction.status === "applied"
  )
    throw new Error("secret_binding_required");
  const base = new URL(options.targetURL);
  const url = new URL(c.path, base);
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("unsafe_http_target");
  await options.authorize(c.method, url);
  const startedAt = new Date().toISOString();
  const parameters = store.sealMaterial(
    "HTTP parameters",
    "data",
    Buffer.from(
      JSON.stringify({
        method: c.method,
        targetName: c.targetName,
        path: c.path,
        headers: c.headers,
        bodyMaterialId: c.bodyMaterialId,
        timeoutMs: checker.timeoutMs,
      }),
    ),
  );
  const result: CollectionResult = {
    materials: [parameters],
    evidence: {
      ...store.record("ev"),
      ...(options.evidenceId ? { id: options.evidenceId } : {}),
      title: "HTTP exchange",
      description: checker.description,
      verificationInputId: input.id,
      claims,
      materials: [],
      source: {
        kind: "tool_capture",
        producer: store.actor,
        deviceId: store.deviceId,
      },
      collection: {
        operation: "http",
        collectorName: "foundry-http",
        collectorVersion: "1",
        inputMaterialId: parameters.id,
        startedAt,
        finishedAt: startedAt,
        outcome: "failed",
        completeness: "complete",
      },
      candidateBinding: "system_observed",
    },
  };
  try {
    const response = await fetch(url, {
      method: c.method,
      headers: c.headers,
      body: c.bodyMaterialId
        ? new Uint8Array(store.readMaterial(c.bodyMaterialId))
        : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(checker.timeoutMs),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 100 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("HTTP response exceeds 100 MiB");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = Buffer.concat(chunks);
    const safe = redactEvidence(bytes);
    const headerCapture = redactEvidence(
      Buffer.from(
        JSON.stringify({
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        }),
      ),
    );
    const responseHeaders = store.sealMaterial(
      "HTTP response metadata",
      "http_exchange",
      headerCapture.bytes,
      headerCapture.redaction,
    );
    result.materials.push(responseHeaders);
    result.evidence.materials.push({
      materialId: responseHeaders.id,
      role: "response",
    });
    const body = store.sealMaterial(
      "HTTP response",
      "http_exchange",
      safe.bytes,
      safe.redaction,
    );
    result.materials.push(body);
    result.evidence.materials.push({ materialId: body.id, role: "response" });
    result.evidence.collection.outcome = "completed";
    result.evidence.collection.httpStatus = response.status;
    const assertions: CheckReport["assertions"] = [
      {
        id: "status",
        expected: c.expectedStatus,
        observed: response.status,
        verdict: response.status === c.expectedStatus ? "pass" : "fail",
      },
    ];
    for (const [name, expected] of Object.entries(c.expectedHeaders)) {
      const observed = response.headers.get(name);
      assertions.push({
        id: `header:${name}`,
        expected,
        observed,
        verdict: expected === observed ? "pass" : "fail",
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(safe.bytes.toString());
    } catch {
      /* JSON assertions fail on non-JSON bodies. */
    }
    for (const [pointer, expected] of Object.entries(c.expectedJsonValues)) {
      const observed = jsonPointer(json, pointer);
      assertions.push({
        id: `json:${pointer}`,
        expected,
        observed: observed === undefined ? null : (observed as never),
        verdict:
          observed !== undefined &&
          digestObject(expected) === digestObject(observed)
            ? "pass"
            : "fail",
      });
    }
    result.assertions = assertions.map((assertion) => {
      const redacted = redactEvidence(Buffer.from(JSON.stringify(assertion)));
      return redacted.redaction.status === "applied"
        ? {
            ...assertion,
            observed: "[REDACTED]",
            verdict: "inconclusive" as const,
          }
        : assertion;
    });
    result.verdict =
      safe.redaction.status === "applied" ||
      result.assertions.some((a) => a.verdict === "inconclusive")
        ? "inconclusive"
        : assertions.every((a) => a.verdict === "pass")
          ? "pass"
          : "fail";
  } catch (error) {
    result.technicalError = {
      code: "http_collection_error",
      message: String(error),
      retryable: true,
    };
    result.evidence.collection.error = {
      code: "http_collection_error",
      message: String(error),
    };
    result.evidence.collection.completeness = "partial";
  }
  result.evidence.collection.finishedAt = new Date().toISOString();
  store.sealRecord("evidence", result.evidence, "Evidence");
  return result;
}
function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!/^(?:\/(?:[^~]|~[01])*)*$/.test(pointer))
    throw new Error("invalid_json_pointer");
  for (const key of pointer
    .slice(1)
    .split("/")
    .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
