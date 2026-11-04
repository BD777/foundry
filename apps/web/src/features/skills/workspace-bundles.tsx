import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SkillBundleSummary } from "@bd777/foundry-protocol";
import { setWorkspaceSkillBundles } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Checkbox } from "../../components/ui/field";
import { RowCard } from "../../components/ui/row-card";
import { SkillCatalogHeading } from "../../components/skills/skill-catalog-heading";
import { DefaultSkillBadge } from "./default-skill-badge";

/**
 * Bundles the workspace uses as a unit: all of a bundle's current skills,
 * including ones its later releases add. Saved as soon as it is toggled.
 * Unchecking one of the owner's default bundles turns it off here only.
 */
export function WorkspaceBundles({
  bundles,
  selectedIds,
  defaultIds,
  workspaceId,
  readOnly,
  onChanged,
}: {
  bundles: SkillBundleSummary[];
  selectedIds: string[];
  defaultIds: string[];
  workspaceId: string;
  readOnly: boolean;
  onChanged?: () => Promise<void>;
}) {
  const { t } = useTranslation("skills");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!bundles.length) return null;
  const hasDefaults = bundles.some((bundle) => defaultIds.includes(bundle.id));
  const toggle = async (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setBusy(true);
    setError("");
    try {
      await setWorkspaceSkillBundles(workspaceId, [...next]);
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="mb-6 grid gap-3"
      aria-labelledby="fdy-workspace-bundles-title"
    >
      <SkillCatalogHeading
        description={
          hasDefaults
            ? t("workspace.bundlesDescriptionWithDefaults")
            : t("workspace.bundlesDescription")
        }
        title={t("workspace.bundlesTitle")}
        titleId="fdy-workspace-bundles-title"
      />
      <ul className="grid gap-1.5">
        {bundles.map((bundle) => {
          const byDefault = defaultIds.includes(bundle.id);
          return (
            <li key={bundle.id}>
              <RowCard
                as="label"
                className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 px-2.75 py-2.25 has-disabled:cursor-default"
                tone="ring"
              >
                <Checkbox
                  aria-label={t("workspace.useBundle", { name: bundle.name })}
                  checked={selectedIds.includes(bundle.id)}
                  disabled={busy || readOnly}
                  onChange={() => void toggle(bundle.id)}
                />
                <span className="grid min-w-0 gap-0.5 text-sm">
                  <strong>
                    {bundle.name}{" "}
                    <Badge dot={false} tone="neutral">
                      {t("library.bundle.badge")}
                    </Badge>{" "}
                    <DefaultSkillBadge
                      off={!selectedIds.includes(bundle.id)}
                      show={byDefault}
                    />
                  </strong>
                  <small className="text-ink-muted [overflow-wrap:anywhere]">
                    {[
                      bundle.version,
                      t("library.repo.skillCount", {
                        count: bundle.skillIds.length,
                      }),
                      bundle.label,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
              </RowCard>
            </li>
          );
        })}
      </ul>
      {error ? <ToastFeedback tone="error" title={error} /> : null}
    </section>
  );
}
