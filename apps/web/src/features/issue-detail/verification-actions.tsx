import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type {
  CandidateSnapshot,
  Issue,
  IssueContract,
  ReviewSnapshot,
  SnapshotFile,
  VerificationInput,
} from "@bd777/foundry-protocol";
import { readCandidateReview, type CandidateReviewData } from "../../api";
import { Button } from "../../components/ui/button";
import { Checkbox, TextInput } from "../../components/ui/field";
import {
  exportCandidateEvidence,
  getMaterial,
  listCandidates,
  listInputs,
  readPreviewMaterial,
  sealCandidate,
  verifyCriteria,
} from "./evidence-api";

/**
 * Files the candidate changed, as `repoId:path`, read from the Git diff of
 * each repository. They are the default material for an agent judgment that
 * names no file: what was delivered.
 */
export function changedEvidenceFiles(
  review: CandidateReviewData["review"],
  repositories: { repoId: string; relativePath: string }[],
): Set<string> {
  const changed = new Set<string>();
  for (const repository of review.repositories) {
    const repoId = repositories.find(
      (r) => r.relativePath === repository.path,
    )?.repoId;
    if (!repoId) continue;
    for (const match of repository.diff.matchAll(
      /^diff --git a\/.+? b\/(.+)$/gm,
    ))
      changed.add(`${repoId}:${match[1]}`);
  }
  return changed;
}

export function suggestedEvidenceFiles(
  files: SnapshotFile[],
  description: string,
): SnapshotFile[] {
  return files.filter(
    (file) =>
      file.kind === "file" &&
      description.toLowerCase().includes(file.path.toLowerCase()),
  );
}

const changesEvidence = "@foundry/candidate-changes";
const isChangesRequirement = (requirement: {
  acceptedCarriers: string[];
  description: string;
}) =>
  requirement.acceptedCarriers.includes("data") &&
  // i18n-ignore: recognizes a requirement's own wording, in either language
  /变更|改动|change|diff/i.test(requirement.description);

export function VerificationActions({
  issue,
  contract,
  review,
  disabled,
  run,
}: {
  issue: Issue;
  contract?: IssueContract;
  review: ReviewSnapshot;
  disabled: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useTranslation("issueDetail");
  const [candidate, setCandidate] = useState<CandidateSnapshot>();
  const [input, setInput] = useState<VerificationInput>();
  const [files, setFiles] = useState<SnapshotFile[]>([]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const targetNames = [
    ...new Set(
      contract?.criteria.flatMap((c) =>
        c.checker?.configuration.kind === "http"
          ? [c.checker.configuration.targetName]
          : [],
      ) ?? [],
    ),
  ];
  const programChecks =
    contract?.criteria.flatMap((c) =>
      c.evaluationMode === "deterministic" &&
      c.checker?.configuration.kind === "project_command"
        ? [{ criterion: c, configuration: c.checker.configuration }]
        : [],
    ) ?? [];
  const requirements =
    contract?.criteria
      .filter((c) => c.evaluationMode === "agent")
      .flatMap((criterion) =>
        criterion.evidenceRequirements.map((requirement) => ({
          criterion,
          requirement,
        })),
      ) ?? [];
  const load = async () => {
    const [snapshots, inputs] = await Promise.all([
      listCandidates(issue.id),
      listInputs(issue.id),
    ]);
    const snapshot = snapshots.items.find(
      (s) => s.id === review.candidateSnapshotId,
    );
    setCandidate(snapshot);
    setInput(
      inputs.items.find(
        (i) =>
          i.candidateSnapshotId === snapshot?.id &&
          i.contractRevision === review.contractRevision,
      ),
    );
    if (!snapshot) {
      setFiles([]);
      return;
    }
    const material = await getMaterial(
      issue.id,
      snapshot.fileManifestMaterialId,
    );
    const manifest = JSON.parse(
      await (await readPreviewMaterial(issue.id, material)).text(),
    ) as SnapshotFile[];
    const changed = await readCandidateReview(issue.id)
      .then((data) => changedEvidenceFiles(data.review, snapshot.repositories))
      .catch(() => new Set<string>());
    const suggested = (text: string) => {
      const named = suggestedEvidenceFiles(manifest, text);
      return named.length
        ? named
        : manifest.filter(
            (file) =>
              file.kind === "file" &&
              changed.has(`${file.repoId}:${file.path}`),
          );
    };
    setFiles(manifest.filter((f) => f.kind === "file"));
    setSelected(
      Object.fromEntries(
        requirements.map(({ criterion, requirement }) => [
          `${criterion.id}/${requirement.id}`,
          isChangesRequirement(requirement)
            ? [changesEvidence]
            : suggested(
                `${requirement.description} ${criterion.statement}`,
              ).map((f) => `${f.repoId}:${f.path}`),
        ]),
      ),
    );
  };
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [issue.id, review.candidateSnapshotId, review.contractRevision]);
  const targetDefinitions = targetNames.map((name) => ({
    name,
    entrypointRelativePath: targets[name] ?? "",
  }));
  const targetsReady = targetDefinitions.every((t) =>
    t.entrypointRelativePath.trim(),
  );
  const aligned = review.blockingReasons.some(
    (b) => b.code === "baseline_changed",
  );
  const missingMaterial = [
    ...new Set(
      requirements
        .filter(
          ({ criterion, requirement }) =>
            (selected[`${criterion.id}/${requirement.id}`]?.length ?? 0) <
            requirement.minimumCount,
        )
        .map(({ criterion }) => t("shared.quoted", { text: criterion.title })),
    ),
  ];
  const canCollect =
    input &&
    requirements.every(
      ({ criterion, requirement }) =>
        ["document", "file", "data", "text_log"].some((c) =>
          requirement.acceptedCarriers.includes(c as "document"),
        ) &&
        (selected[`${criterion.id}/${requirement.id}`]?.length ?? 0) >=
          requirement.minimumCount,
    );

  return (
    <section className="fdy-issue-card">
      <h3>
        {candidate
          ? t("verification.titleCollect")
          : t("verification.titlePrepare")}
      </h3>
      <p>{t("verification.intro")}</p>
      {!candidate || aligned ? (
        <>
          {targetNames.map((name) => (
            <label key={name}>
              {t("verification.entryLabel", { name })}
              <TextInput
                aria-label={t("verification.entryAria", { name })}
                placeholder={t("verification.entryPlaceholder")}
                value={targets[name] ?? ""}
                onChange={(e) =>
                  setTargets((t) => ({ ...t, [name]: e.target.value }))
                }
              />
            </label>
          ))}
          <Button
            disabled={disabled || !targetsReady || !issue.run?.environmentId}
            onClick={() =>
              void run(async () => {
                await sealCandidate(
                  issue.id,
                  review.contractRevision,
                  crypto.randomUUID(),
                  targetDefinitions,
                  aligned ? review.candidateSnapshotId : undefined,
                );
              })
            }
          >
            {aligned ? t("verification.align") : t("verification.prepare")}
          </Button>
          {aligned ? <p>{t("verification.alignNote")}</p> : null}
        </>
      ) : (
        <>
          {requirements.map(({ criterion, requirement }) => {
            const key = `${criterion.id}/${requirement.id}`;
            const accepted = requirement.acceptedCarriers.some((c) =>
              ["document", "file", "data", "text_log"].includes(c),
            );
            return (
              <div className="fdy-evidence-file-selection" key={key}>
                <h4>{criterion.title}</h4>
                <p>{requirement.description}</p>
                {accepted ? (
                  <>
                    <p>
                      {t("verification.planned", {
                        items:
                          (selected[key] ?? [])
                            .map((identity) => {
                              if (identity === changesEvidence)
                                return t("verification.changesList");
                              const file = files.find(
                                (f) => `${f.repoId}:${f.path}` === identity,
                              );
                              const repo = candidate.repositories.find(
                                (r) => r.repoId === file?.repoId,
                              );
                              return `${repo?.relativePath && repo.relativePath !== "." ? `${repo.relativePath}/` : ""}${file?.path ?? t("verification.materialUnavailable")}`;
                            })
                            .join(t("shared.listSeparator")) ||
                          t("verification.noneFound"),
                      })}
                    </p>
                    <details>
                      <summary>
                        {t("verification.adjust", {
                          minimum: requirement.minimumCount,
                        })}
                      </summary>
                      <div className="fdy-evidence-file-list">
                        {requirement.acceptedCarriers.includes("data") ? (
                          <label>
                            <Checkbox
                              checked={
                                selected[key]?.includes(changesEvidence) ??
                                false
                              }
                              disabled={disabled}
                              onChange={(e) =>
                                setSelected((s) => ({
                                  ...s,
                                  [key]: e.target.checked
                                    ? [...(s[key] ?? []), changesEvidence]
                                    : (s[key] ?? []).filter(
                                        (id) => id !== changesEvidence,
                                      ),
                                }))
                              }
                            />
                            <span>{t("verification.changesOption")}</span>
                          </label>
                        ) : null}
                        {files.map((file) => {
                          const identity = `${file.repoId}:${file.path}`;
                          const repo = candidate.repositories.find(
                            (r) => r.repoId === file.repoId,
                          );
                          return (
                            <label key={identity}>
                              <Checkbox
                                checked={
                                  selected[key]?.includes(identity) ?? false
                                }
                                disabled={disabled}
                                onChange={(e) =>
                                  setSelected((s) => ({
                                    ...s,
                                    [key]: e.target.checked
                                      ? [...(s[key] ?? []), identity]
                                      : (s[key] ?? []).filter(
                                          (id) => id !== identity,
                                        ),
                                  }))
                                }
                              />
                              <span>
                                {repo?.relativePath && repo.relativePath !== "."
                                  ? `${repo.relativePath}/`
                                  : ""}
                                {file.path}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </details>
                  </>
                ) : (
                  <p>{t("verification.nonFile")}</p>
                )}
              </div>
            );
          })}
          {programChecks.map(({ criterion, configuration }) => (
            <div className="fdy-evidence-file-selection" key={criterion.id}>
              <h4>{criterion.title}</h4>
              <p>{t("verification.programIntro")}</p>
              <ProgramCommand
                command={[configuration.executable, ...configuration.args].join(
                  " ",
                )}
                cwd={configuration.cwdRelativePath}
              />
            </div>
          ))}
          {input && missingMaterial.length ? (
            <p role="note">
              {t("verification.missing", {
                criteria: missingMaterial.join(t("shared.listSeparator")),
              })}
            </p>
          ) : null}
          <Button
            disabled={disabled || !canCollect}
            onClick={() =>
              void run(async () => {
                if (!input || !contract) return;
                for (const { criterion, requirement } of requirements) {
                  for (const identity of selected[
                    `${criterion.id}/${requirement.id}`
                  ] ?? []) {
                    if (identity === changesEvidence) {
                      await exportCandidateEvidence(
                        issue.id,
                        input,
                        "",
                        "",
                        [
                          {
                            criterionId: criterion.id,
                            requirementId: requirement.id,
                            purpose: requirement.description,
                          },
                        ],
                        crypto.randomUUID(),
                        "data",
                        "candidate_changes",
                      );
                      continue;
                    }
                    const file = files.find(
                      (f) => `${f.repoId}:${f.path}` === identity,
                    )!;
                    await exportCandidateEvidence(
                      issue.id,
                      input,
                      file.repoId,
                      file.path,
                      [
                        {
                          criterionId: criterion.id,
                          requirementId: requirement.id,
                          purpose: requirement.description,
                        },
                      ],
                      crypto.randomUUID(),
                      requirement.acceptedCarriers.find((c) =>
                        ["document", "file", "data", "text_log"].includes(c),
                      )!,
                    );
                  }
                }
                await verifyCriteria(
                  issue.id,
                  review.contractRevision,
                  candidate.id,
                  contract.criteria.map((c) => c.id),
                  crypto.randomUUID(),
                );
              })
            }
          >
            {t("verification.collect")}
          </Button>
          <p>{t("verification.collectNote")}</p>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

/** A short command reads inline; a long script sits behind a disclosure. */
function ProgramCommand({ command, cwd }: { command: string; cwd: string }) {
  const { t } = useTranslation("issueDetail");
  if (command.length <= 80)
    return (
      <p>
        <Trans
          ns="issueDetail"
          i18nKey="verification.commandInline"
          values={{ command, cwd }}
          components={{ code: <code /> }}
        />
      </p>
    );
  return (
    <details>
      <summary>{t("verification.commandSummary", { cwd })}</summary>
      <code>{command}</code>
    </details>
  );
}
