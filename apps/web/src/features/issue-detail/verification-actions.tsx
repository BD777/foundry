import { useEffect, useState } from "react";
import type {
  CandidateSnapshot,
  Issue,
  IssueContract,
  ReviewSnapshot,
  SnapshotFile,
  VerificationInput,
} from "@foundry/protocol";
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
    setFiles(manifest.filter((f) => f.kind === "file"));
    setSelected(
      Object.fromEntries(
        requirements.map(({ criterion, requirement }) => [
          `${criterion.id}/${requirement.id}`,
          isChangesRequirement(requirement)
            ? [changesEvidence]
            : suggestedEvidenceFiles(
                manifest,
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
      <h3>{candidate ? "采集与检查" : "准备实际验收材料"}</h3>
      <p>
        系统从固定候选读取真实文件，保存原始材料，再逐条检查。不会把实现总结当成证据。
      </p>
      {!candidate || aligned ? (
        <>
          {targetNames.map((name) => (
            <label key={name}>
              服务“{name}”的候选入口文件
              <TextInput
                aria-label={`服务 ${name} 入口文件`}
                placeholder="例如 handler.mjs（默认导出 Node HTTP handler）"
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
            {aligned ? "对齐 Workspace 并准备新一轮验收" : "准备当前版本的验收"}
          </Button>
          {aligned ? <p>对齐会生成新的候选，旧判断和批准不能复用。</p> : null}
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
                      计划采集：
                      {(selected[key] ?? [])
                        .map((identity) => {
                          if (identity === changesEvidence)
                            return "系统生成的候选变更清单";
                          const file = files.find(
                            (f) => `${f.repoId}:${f.path}` === identity,
                          );
                          const repo = candidate.repositories.find(
                            (r) => r.repoId === file?.repoId,
                          );
                          return `${repo?.relativePath && repo.relativePath !== "." ? `${repo.relativePath}/` : ""}${file?.path ?? "材料不可用"}`;
                        })
                        .join("、") || "尚未找到合适材料，请展开选择"}
                      。
                    </p>
                    <details>
                      <summary>
                        调整取证材料（至少 {requirement.minimumCount} 份）
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
                            <span>
                              系统生成的候选变更清单（与原始基线比较，不是 Agent
                              自述）
                            </span>
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
                  <p>
                    这里需要非文件类材料。本轮不能自动采集这种材料，不能用文稿替代；请调整取证方案或使用材料管理。
                  </p>
                )}
              </div>
            );
          })}
          {programChecks.map(({ criterion, configuration }) => (
            <div className="fdy-evidence-file-selection" key={criterion.id}>
              <h4>{criterion.title}</h4>
              <p>
                系统自己运行项目的命令，退出码决定通过与否，输出原样留作依据。
              </p>
              <p>
                将运行：
                <code>
                  {[configuration.executable, ...configuration.args].join(" ")}
                </code>
                （工作目录 {configuration.cwdRelativePath}，无网络）。
              </p>
            </div>
          ))}
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
            采集所选材料并检查全部标准
          </Button>
          <p>材料和结果会保留。再次点击将创建新一轮检查，不复用旧通过。</p>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
