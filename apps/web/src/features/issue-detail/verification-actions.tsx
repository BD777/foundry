import { ToastFeedback } from "../../components/ui/toast";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type {
  CandidateSnapshot,
  CarrierKind,
  EvidenceRequirement,
  Issue,
  IssueContract,
  ReviewSnapshot,
  SnapshotFile,
  VerificationInput,
} from "@bd777/foundry-protocol";
import { requirementSourceCarriers } from "@bd777/foundry-protocol";
import {
  readCandidateReview,
  type CandidateReviewData,
  exportCandidateEvidence,
  getMaterial,
  listCandidates,
  listInputs,
  readPreviewMaterial,
  sealCandidate,
  verifyCriteria,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { HelpHint } from "../../components/ui/help-hint";
import { Checkbox, TextInput } from "../../components/ui/field";
import { IssueSection } from "./issue-section";

const fileOptionClass = "flex items-start gap-2.5 p-1.5 wrap-anywhere";

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
const fileCarriers = requirementSourceCarriers("candidate_file");
const changesCarriers = requirementSourceCarriers("candidate_changes");
const accepts = (requirement: EvidenceRequirement, carriers: CarrierKind[]) =>
  requirement.acceptedCarriers.some((c) => carriers.includes(c));
/**
 * Which candidate exports can supply a requirement: the source it names, or,
 * for a contract confirmed before requirements named one, what its carriers
 * allow.
 */
export function candidateExports(requirement: EvidenceRequirement) {
  if (requirement.source)
    return {
      files: requirement.source === "candidate_file",
      changes: requirement.source === "candidate_changes",
    };
  return {
    files: accepts(requirement, fileCarriers),
    changes: accepts(requirement, changesCarriers),
  };
}
const collectable = (requirement: EvidenceRequirement) => {
  const exports = candidateExports(requirement);
  return exports.files || exports.changes;
};
const isChangesRequirement = (requirement: EvidenceRequirement) =>
  requirement.source
    ? requirement.source === "candidate_changes"
    : accepts(requirement, changesCarriers) &&
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
            : candidateExports(requirement).files
              ? suggested(
                  `${requirement.description} ${criterion.statement}`,
                ).map((f) => `${f.repoId}:${f.path}`)
              : [],
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
        collectable(requirement) &&
        (selected[`${criterion.id}/${requirement.id}`]?.length ?? 0) >=
          requirement.minimumCount,
    );

  return (
    <IssueSection>
      <h3 className="flex items-center gap-1.5">
        {candidate
          ? t("verification.titleCollect")
          : t("verification.titlePrepare")}
        <HelpHint label={t("verification.introHelp")}>
          {t("verification.intro")}
        </HelpHint>
      </h3>
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
          <div className="flex flex-wrap items-center gap-2">
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
            {aligned ? (
              <HelpHint label={t("verification.alignHelp")}>
                {t("verification.alignNote")}
              </HelpHint>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {requirements.map(({ criterion, requirement }) => {
            const key = `${criterion.id}/${requirement.id}`;
            const exports = candidateExports(requirement);
            return (
              <div className="grid gap-2" key={key}>
                <h4>{criterion.title}</h4>
                <p>{requirement.description}</p>
                {exports.files || exports.changes ? (
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
                      <div className="grid max-h-[220px] gap-1.5 overflow-y-auto">
                        {exports.changes ? (
                          <label className={fileOptionClass}>
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
                        {(exports.files ? files : []).map((file) => {
                          const identity = `${file.repoId}:${file.path}`;
                          const repo = candidate.repositories.find(
                            (r) => r.repoId === file.repoId,
                          );
                          return (
                            <label className={fileOptionClass} key={identity}>
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
                  <Alert
                    size="compact"
                    title={t("verification.nonFile")}
                    tone="warning"
                  />
                )}
              </div>
            );
          })}
          {programChecks.map(({ criterion, configuration }) => (
            <div className="grid gap-2" key={criterion.id}>
              <h4 className="flex items-center gap-1.5">
                {criterion.title}
                <HelpHint label={t("verification.programHelp")}>
                  {t("verification.programIntro")}
                </HelpHint>
              </h4>
              <ProgramCommand
                command={[configuration.executable, ...configuration.args].join(
                  " ",
                )}
                cwd={configuration.cwdRelativePath}
              />
            </div>
          ))}
          {input && missingMaterial.length ? (
            <Alert
              size="compact"
              title={t("verification.missing", {
                criteria: missingMaterial.join(t("shared.listSeparator")),
              })}
              tone="warning"
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
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
                          requirement.acceptedCarriers.find((c) =>
                            changesCarriers.includes(c),
                          )!,
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
                          fileCarriers.includes(c),
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
            <HelpHint label={t("verification.collectHelp")}>
              {t("verification.collectNote")}
            </HelpHint>
          </div>
        </>
      )}
      {error ? <ToastFeedback tone="error" title={error} /> : null}
    </IssueSection>
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
