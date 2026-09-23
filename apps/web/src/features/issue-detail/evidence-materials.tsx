import { useEffect, useState } from "react";
import type {
  CandidateSnapshot,
  Issue,
  IssueContract,
  Material,
  VerificationInput,
} from "@foundry/protocol";
import { FileInput, Textarea, TextInput } from "../../components/ui/field";
import { Button } from "../../components/ui/button";
import { SelectMenu } from "../../components/ui/select-menu";
import { EvidencePreview } from "./evidence-preview";
import { useEvidenceUpdates } from "./use-evidence-updates";
import {
  downloadMaterial,
  exportCandidateEvidence,
  listCandidates,
  listContracts,
  listInputs,
  listMaterials,
  registerHumanEvidence,
  uploadMaterial,
} from "./evidence-api";

export function EvidenceMaterials({
  issue,
  onChange,
}: {
  issue: Issue;
  onChange: () => Promise<void>;
}) {
  const terminal = issue.status === "accepted" || issue.status === "abandoned";
  const [materials, setMaterials] = useState<Material[]>([]);
  const [input, setInput] = useState<VerificationInput>(),
    [candidate, setCandidate] = useState<CandidateSnapshot>(),
    [contract, setContract] = useState<IssueContract>();
  const [selection, setSelection] = useState(""),
    [attestation, setAttestation] = useState(""),
    [path, setPath] = useState(""),
    [repoId, setRepoId] = useState("");
  const [file, setFile] = useState<File>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    const [m, i, c, k] = await Promise.all([
      listMaterials(issue.id),
      listInputs(issue.id),
      listCandidates(issue.id),
      listContracts(issue.id),
    ]);
    setMaterials(m.items);
    setInput(
      i.items.find(
        (x) =>
          x.candidateSnapshotId === issue.currentCandidateSnapshotId &&
          x.contractRevision === issue.currentContractRevision,
      ),
    );
    setCandidate(
      c.items.find((x) => x.id === issue.currentCandidateSnapshotId),
    );
    setContract(
      k.items.find((x) => x.revision === issue.currentContractRevision),
    );
  };
  useEvidenceUpdates(issue.id, load, setError);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [
    issue.id,
    issue.currentCandidateSnapshotId,
    issue.currentContractRevision,
  ]);
  const options =
    contract?.criteria.flatMap((c) =>
      c.evidenceRequirements.map((r) => ({
        value: `${c.id}/${r.id}`,
        label: `${c.title}: ${r.description}`,
      })),
    ) ?? [];
  const selected = contract?.criteria
    .flatMap((c) =>
      c.evidenceRequirements.map((r) => ({ c, r, key: `${c.id}/${r.id}` })),
    )
    .find((x) => x.key === selection);
  const claims = selected
    ? [
        {
          criterionId: selected.c.id,
          requirementId: selected.r.id,
          purpose: selected.r.description,
        },
      ]
    : [];
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      await onChange();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>Actual materials and collection</summary>
      <ul>
        {materials.map((m) => (
          <li key={m.id}>
            <Button
              variant="ghost"
              onClick={() => void run(() => downloadMaterial(issue.id, m))}
            >
              {m.name} · {m.carrier} · {m.availability}
            </Button>
            <code>{m.id}</code>
            <EvidencePreview
              issueId={issue.id}
              materialId={m.id}
              label="Preview sealed material"
            />
          </li>
        ))}
      </ul>
      <SelectMenu
        ariaLabel="Evidence requirement"
        options={options}
        value={selection}
        onChange={setSelection}
        placeholder="Select the exact evidence requirement"
      />
      <FileInput
        aria-label="Upload actual evidence or reference material"
        onChange={(e) => setFile(e.target.files?.[0])}
      />
      <Textarea
        aria-label="Material provenance and candidate attestation"
        placeholder="Where was this captured, and why does it represent this exact candidate?"
        value={attestation}
        onChange={(e) => setAttestation(e.target.value)}
      />
      <Button
        disabled={busy || terminal || !file}
        onClick={() =>
          void run(async () => {
            if (!file) return;
            const material = await uploadMaterial(
              issue.id,
              file,
              file.type.startsWith("image/") ? "image" : "document",
              crypto.randomUUID(),
            );
            if (!input || !selected || !attestation.trim()) return;
            if (
              selected.c.evaluationMode !== "agent" ||
              selected.r.bindingPolicy !== "system_or_human_attested"
            )
              throw new Error(
                `Material ${material.id} saved. This requirement does not permit human-attested evidence.`,
              );
            const parameters = await uploadMaterial(
              issue.id,
              new File(
                [
                  JSON.stringify({
                    fileName: file.name,
                    sourceDescription: attestation,
                    verificationInputId: input.id,
                  }),
                ],
                "upload-parameters.json",
                { type: "application/json" },
              ),
              "data",
              crypto.randomUUID(),
            );
            await registerHumanEvidence(
              issue.id,
              input,
              material,
              claims,
              attestation,
              parameters,
              crypto.randomUUID(),
            );
          })
        }
      >
        Upload material
        {selected && attestation.trim() ? " and attest candidate binding" : ""}
      </Button>
      <p>
        Upload alone creates a Material, not proof. Reference material IDs can
        be added to the next contract draft’s media fields.
      </p>
      <SelectMenu
        ariaLabel="Snapshot repository"
        options={
          candidate?.repositories.map((r) => ({
            value: r.repoId,
            label: r.relativePath,
          })) ?? []
        }
        value={repoId}
        onChange={setRepoId}
      />
      <TextInput
        aria-label="Candidate file path"
        placeholder="Relative file path in the sealed snapshot"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <Button
        disabled={busy || terminal || !input || !repoId || !path || !selected}
        onClick={() =>
          void run(async () => {
            await exportCandidateEvidence(
              issue.id,
              input!,
              repoId,
              path,
              claims,
              crypto.randomUUID(),
            );
          })
        }
      >
        Export candidate file as evidence
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
