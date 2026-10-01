import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CandidateSnapshot,
  Issue,
  IssueContract,
  Material,
  VerificationInput,
} from "@bd777/foundry-protocol";
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
  const { t } = useTranslation("issueDetail");
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
        label: t("materials.requirementOption", {
          criterion: c.title,
          requirement: r.description,
        }),
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
      <summary>{t("materials.summary")}</summary>
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
              label={t("materials.previewSealed")}
            />
          </li>
        ))}
      </ul>
      <SelectMenu
        ariaLabel={t("materials.requirement")}
        options={options}
        value={selection}
        onChange={setSelection}
        placeholder={t("materials.requirementPlaceholder")}
      />
      <FileInput
        aria-label={t("materials.upload")}
        onChange={(e) => setFile(e.target.files?.[0])}
      />
      <Textarea
        aria-label={t("materials.attestationLabel")}
        placeholder={t("materials.attestationPlaceholder")}
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
                t("materials.notAttestable", { id: material.id }),
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
        {selected && attestation.trim()
          ? t("materials.uploadAndAttest")
          : t("materials.uploadButton")}
      </Button>
      <p>{t("materials.uploadNote")}</p>
      <SelectMenu
        ariaLabel={t("materials.repository")}
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
        aria-label={t("materials.path")}
        placeholder={t("materials.pathPlaceholder")}
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
        {t("materials.export")}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
