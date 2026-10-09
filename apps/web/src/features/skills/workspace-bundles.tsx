import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SkillBundleSummary } from "@bd777/foundry-protocol";
import { setWorkspaceSkillBundles } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Checkbox } from "../../components/ui/field";
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
      className="fdy-workspace-bundles"
      aria-labelledby="fdy-workspace-bundles-title"
    >
      <header className="fdy-skill-catalog-heading">
        <div className="fdy-skill-catalog-heading-copy">
          <h2 id="fdy-workspace-bundles-title">
            {t("workspace.bundlesTitle")}
          </h2>
          <p>
            {hasDefaults
              ? t("workspace.bundlesDescriptionWithDefaults")
              : t("workspace.bundlesDescription")}
          </p>
        </div>
      </header>
      <ul className="fdy-skill-repo-choices">
        {bundles.map((bundle) => {
          const byDefault = defaultIds.includes(bundle.id);
          return (
            <li key={bundle.id}>
              <label>
                <Checkbox
                  aria-label={t("workspace.useBundle", { name: bundle.name })}
                  checked={selectedIds.includes(bundle.id)}
                  disabled={busy || readOnly}
                  onChange={() => void toggle(bundle.id)}
                />
                <span>
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
                  <small>
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
              </label>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="fdy-skill-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
