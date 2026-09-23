import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionStore } from "../dist/execution-storage.js";
import { EvidenceStore, digestObject } from "../dist/evidence-store.js";
import { judgeWithAgent } from "../dist/evidence-agent.js";
import { configuredAgentProfiles, profileID } from "../dist/profiles.js";
import { deflateSync } from "node:zlib";

function contextPNG() {
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((64 * 3 + 1) * 64, 255);
  for (let y = 0; y < 64; y++) pixels[y * (64 * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Explicit opt-in: never make a paid/provider request in normal test runs.
test(
  "live isolated SDK receives text and actual image, returns cited Result",
  {
    skip:
      process.env.FOUNDRY_VERIFY_LIVE !== "1" || process.platform !== "darwin",
    timeout: 210000,
  },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), "foundry-live-evidence-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const harness = process.env.FOUNDRY_VERIFY_HARNESS ?? "claude";
    const profile = configuredAgentProfiles("").find(
      (p) => p.runtime === harness && profileID(p) === `${harness}_local`,
    );
    assert.ok(profile, "Existing local profile required");
    const store = new EvidenceStore(
      "ws_live_fixture",
      "iss_live_fixture",
      "dev_fixture",
      { kind: "daemon", id: "dev_fixture", displayName: "Synthetic test" },
      new ExecutionStore(resolve(root, "state")),
    );
    const reference = store.sealMaterial(
      "reference",
      "document",
      Buffer.from("Required sections: Goal and Outcome."),
    );
    const actual = store.sealMaterial(
      "candidate document",
      "document",
      Buffer.from(
        "# Goal\nValidate the synthetic fixture.\n# Outcome\nThe fixture is complete.",
      ),
    );
    const image = store.sealMaterial("context image", "image", contextPNG());
    const params = store.sealMaterial(
      "capture parameters",
      "data",
      Buffer.from('{"fixture":true}'),
    );
    const criterion = {
      id: "criterion",
      title: "Complete document",
      statement:
        "Document includes Goal and Outcome sections. The context image is a valid supplied image, not proof of text content.",
      required: true,
      proofKind: "content_completeness",
      evaluationMode: "agent",
      rubric: {
        text: "Compare actual document sections to the reference. Inspect the supplied context image; do not invent details in the blank white image.",
        media: [
          {
            materialId: reference.id,
            role: "target",
            caption: "Section names",
          },
          {
            materialId: image.id,
            role: "context",
            caption: "Actual attached context image",
          },
        ],
      },
      evidenceRequirements: [
        {
          id: "document",
          description: "Full candidate document",
          acceptedCarriers: ["document"],
          minimumCount: 1,
          bindingPolicy: "system_observed",
        },
      ],
    };
    const contract = {
      ...store.record("contract"),
      revision: 1,
      origin: "user",
      goal: { text: "Review this synthetic document", media: [] },
      inScope: [],
      outOfScope: [],
      constraints: [],
      criteria: [criterion],
      status: "confirmed",
      contentDigest: digestObject(criterion),
    };
    const input = {
      ...store.record("input"),
      contractRevision: 1,
      contractDigest: contract.contentDigest,
      candidateSnapshotId: "synthetic_snapshot",
      candidateDigest: digestObject("synthetic"),
      environment: {
        deviceId: "dev_fixture",
        executionEnvironmentId: "fixture",
        os: process.platform,
        architecture: process.arch,
        tools: [],
        configurationDigest: digestObject({}),
      },
      dependencies: [],
      targets: [],
      inputDigest: digestObject("fixture-input"),
      bindingStatus: "verified",
      bindingNotes: [],
    };
    const evidence = {
      ...store.record("ev"),
      title: "Actual document",
      description: "Synthetic candidate text",
      verificationInputId: input.id,
      claims: [
        {
          criterionId: criterion.id,
          requirementId: "document",
          purpose: "Review sections",
        },
      ],
      materials: [{ materialId: actual.id, role: "primary" }],
      source: { kind: "candidate_export", producer: store.actor },
      collection: {
        operation: "file_export",
        collectorName: "test",
        collectorVersion: "1",
        inputMaterialId: params.id,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outcome: "completed",
        completeness: "complete",
      },
      candidateBinding: "system_observed",
    };
    const verification = {
      ...store.record("verify"),
      sequence: 1,
      criterionId: criterion.id,
      contractRevision: 1,
      verificationInputId: input.id,
      evidenceIds: [evidence.id],
      mode: "agent",
      executor: {
        kind: "agent",
        harness,
        profileId: profileID(profile),
        requestedModel: profile.model ?? "",
        sessionId: "synthetic-session",
        promptTemplateVersion: "foundry-verification/v1",
        promptDigest: digestObject("pending"),
        isolated: true,
      },
      status: "queued",
    };
    const directory = resolve(root, "judge");
    mkdirSync(directory);
    const judged = await judgeWithAgent({
      contract,
      criterion,
      input,
      verification,
      evidence: [evidence],
      store,
      directory,
    });
    assert.ok(["pass", "fail", "inconclusive"].includes(judged.result.verdict));
    assert.ok(
      judged.result.findings.some((f) =>
        f.evidenceCitations.some(
          (c) => c.evidenceId === evidence.id && c.materialId === actual.id,
        ),
      ),
      "Must cite actual supplied material",
    );
    for (const finding of judged.result.findings)
      for (const citation of finding.evidenceCitations) {
        assert.equal(citation.evidenceId, evidence.id);
        assert.equal(citation.materialId, actual.id);
      }
    t.diagnostic(
      JSON.stringify({
        harness,
        verdict: judged.result.verdict,
        reportedModel: judged.reportedModel,
        findings: judged.result.findings.length,
      }),
    );
  },
);
