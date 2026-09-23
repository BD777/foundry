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
  const fields =
    runtime === "claude"
      ? [
          {
            field: "claudeEffort" as const,
            label: "Claude effort",
            options: claudeEffortOptions,
          },
          {
            field: "claudePermissionMode" as const,
            label: "Claude permission",
            options: claudePermissionOptions,
          },
        ]
      : [
          {
            field: "codexReasoningEffort" as const,
            label: "Codex reasoning effort",
            options: codexEffortOptions,
          },
          {
            field: "codexSandboxMode" as const,
            label: "Codex sandbox",
            options: codexSandboxOptions,
          },
          {
            field: "codexApprovalPolicy" as const,
            label: "Codex approval",
            options: codexApprovalOptions,
          },
          {
            field: "codexSpeed" as const,
            label: "Codex speed",
            options: codexSpeedOptions,
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
                ? [{ value: "", label: "Foundry default" }, ...options]
                : options
            }
            onChange={(next) => onChange({ [field]: next || undefined })}
          />
        </label>
      ))}
    </div>
  );
}
