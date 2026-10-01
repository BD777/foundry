import { useTranslation } from "react-i18next";
import type { CreateAgentProfileInput } from "../../api-types";
import { SelectMenu } from "./select-menu";
import {
  claudeEffortOptions,
  claudePermissionOptions,
  codexApprovalOptions,
  codexEffortOptions,
  codexSandboxOptions,
  codexSpeedOptions,
} from "../../lib/runtime-options";

type Values = Pick<
  CreateAgentProfileInput,
  | "claudeEffort"
  | "claudePermissionMode"
  | "codexReasoningEffort"
  | "codexSandboxMode"
  | "codexApprovalPolicy"
  | "codexSpeed"
>;

/** Shared by device accounts and server connection editors. */
export function RuntimeDefaultFields({
  runtime,
  value,
  onChange,
  insideDialog = false,
  inherit = false,
}: {
  runtime: "claude" | "codex";
  value: Values;
  onChange: (patch: Values) => void;
  insideDialog?: boolean;
  inherit?: boolean;
}) {
  const { t } = useTranslation("agents");
  const fields =
    runtime === "claude"
      ? [
          {
            field: "claudeEffort" as const,
            label: t("defaults.claudeEffort"),
            options: claudeEffortOptions(),
          },
          {
            field: "claudePermissionMode" as const,
            label: t("defaults.claudePermission"),
            options: claudePermissionOptions(),
          },
        ]
      : [
          {
            field: "codexReasoningEffort" as const,
            label: t("defaults.codexEffort"),
            options: codexEffortOptions(),
          },
          {
            field: "codexSandboxMode" as const,
            label: t("defaults.codexSandbox"),
            options: codexSandboxOptions(),
          },
          {
            field: "codexApprovalPolicy" as const,
            label: t("defaults.codexApproval"),
            options: codexApprovalOptions(),
          },
          {
            field: "codexSpeed" as const,
            label: t("defaults.codexSpeed"),
            options: codexSpeedOptions(),
          },
        ];
  return (
    <div className="fdy-runtime-default-fields">
      {fields.map(({ field, label, options }) => (
        <label className="fdy-profile-field" key={field}>
          <span>{label}</span>
          <SelectMenu
            ariaLabel={label}
            insideDialog={insideDialog}
            value={value[field] ?? ""}
            options={
              inherit
                ? [
                    { value: "", label: t("defaults.foundryDefault") },
                    ...options,
                  ]
                : options
            }
            onChange={(next) => onChange({ [field]: next || undefined })}
          />
        </label>
      ))}
    </div>
  );
}
