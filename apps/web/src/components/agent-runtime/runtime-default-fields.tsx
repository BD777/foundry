import { useTranslation } from "react-i18next";
import type { AgentModelOption } from "@bd777/foundry-protocol";
import type { CreateAgentProfileInput } from "../../api-types";
import { SelectMenu } from "../ui/select-menu";
import { profileFieldClass } from "./profile-field";
import {
  claudeEffortOptions,
  claudePermissionOptions,
  codexApprovalOptions,
  codexEffortOptions,
  codexSandboxOptions,
  codexSpeedOptions,
} from "../../lib/runtime-options";
import { catalogModel } from "../../lib/agent-effort";

type Values = Pick<
  CreateAgentProfileInput,
  | "claudeEffort"
  | "claudePermissionMode"
  | "codexReasoningEffort"
  | "codexSandboxMode"
  | "codexApprovalPolicy"
  | "codexSpeed"
>;

/**
 * Shared by device accounts and model provider editors. Codex offers the
 * efforts of the model's own catalog entry: `catalog` is what the device read,
 * `model` the chosen model (blank: the account's default).
 */
export function RuntimeDefaultFields({
  runtime,
  value,
  onChange,
  insideDialog = false,
  inherit = false,
  catalog = [],
  model = "",
}: {
  runtime: "claude" | "codex";
  value: Values;
  onChange: (patch: Values) => void;
  insideDialog?: boolean;
  inherit?: boolean;
  catalog?: AgentModelOption[];
  model?: string;
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
            options: codexEffortOptions(catalogModel(catalog, model)),
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
    <div className="grid grid-cols-2 gap-x-4 gap-y-5">
      {fields.map(({ field, label, options }) => (
        <label className={profileFieldClass} key={field}>
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
