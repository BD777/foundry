import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceInstance } from "@bd777/foundry-protocol";
import { saveDeviceResourceSettings } from "../../api";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { CheckLabel } from "../../components/ui/check-label";
import { Checkbox, FieldHint, Radio } from "../../components/ui/field";
import { LoadingState } from "../../components/ui/loading";
import { useResourceAction } from "./resource-action";

export interface ResourceWorkspaceChoice {
  id: string;
  name: string;
}

type PolicyMode = "every" | "only" | "except";
const policyModes: readonly PolicyMode[] = ["every", "only", "except"];

interface PolicyDraft {
  mode: PolicyMode;
  picked: readonly string[];
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * The device owner's choice of which workspaces' sessions may lease its
 * resources: every workspace, only these (allowWorkspaces) or every
 * workspace except these (denyWorkspaces). Saved with a button, since a
 * choice takes a few clicks.
 */
export function ResourceWorkspacePolicy({
  instance,
  allow,
  deny,
  workspaces,
  disabled = false,
  onChanged,
}: {
  instance: ResourceInstance;
  /** ResourceSourceStatus.allowWorkspaces; empty lets every workspace. */
  allow: readonly string[];
  /** ResourceSourceStatus.denyWorkspaces. */
  deny: readonly string[];
  workspaces: readonly ResourceWorkspaceChoice[];
  disabled?: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation("resources");
  const name = useId();
  const action = useResourceAction<"save">();
  const saved: PolicyDraft = allow.length
    ? { mode: "only", picked: allow }
    : deny.length
      ? { mode: "except", picked: deny }
      : { mode: "every", picked: [] };
  const savedKey = `${saved.mode}:${saved.picked.join(",")}`;
  const [draft, setDraft] = useState<PolicyDraft>();
  // A fresh read of the inventory is the truth again.
  useEffect(() => setDraft(undefined), [savedKey]);

  const current = draft ?? saved;
  const changed =
    current.mode !== saved.mode ||
    (current.mode !== "every" && !sameIds(current.picked, saved.picked));
  const valid = current.mode === "every" || current.picked.length > 0;
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const choices: ResourceWorkspaceChoice[] = [
    ...workspaces,
    ...current.picked
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: t("workspacePolicy.unknownWorkspace") })),
  ];

  const toggle = (id: string, on: boolean) =>
    setDraft({
      ...current,
      picked: on
        ? [...current.picked, id]
        : current.picked.filter((picked) => picked !== id),
    });
  const save = () =>
    void action.run("save", async () => {
      await saveDeviceResourceSettings(instance.source.id, {
        allowWorkspaces: current.mode === "only" ? [...current.picked] : [],
        denyWorkspaces: current.mode === "except" ? [...current.picked] : [],
      });
      onChanged();
      return "";
    });

  return (
    <fieldset
      aria-busy={Boolean(action.running)}
      className="fdy-res-policy m-0 grid min-w-0 gap-1.5 border-0 p-0"
      disabled={disabled || Boolean(action.running)}
    >
      <legend className="mb-1.5 p-0 text-xs leading-normal text-ink">
        {t("workspacePolicy.title")}
      </legend>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1">
        {policyModes.map((mode) => (
          <CheckLabel className="items-center [&>input]:mt-0" key={mode}>
            <Radio
              checked={current.mode === mode}
              name={name}
              value={mode}
              onChange={() => setDraft({ ...current, mode })}
            />
            <span>{t(`workspacePolicy.modes.${mode}`)}</span>
          </CheckLabel>
        ))}
      </div>
      {current.mode !== "every" ? (
        choices.length ? (
          <ul className="m-0 flex list-none flex-wrap gap-x-3.5 gap-y-1 p-0">
            {choices.map((workspace) => (
              <li key={workspace.id}>
                <CheckLabel className="items-center [&>input]:mt-0">
                  <Checkbox
                    checked={current.picked.includes(workspace.id)}
                    onChange={(event) =>
                      toggle(workspace.id, event.currentTarget.checked)
                    }
                  />
                  <span>{workspace.name}</span>
                </CheckLabel>
              </li>
            ))}
          </ul>
        ) : (
          <FieldHint className="mt-0">
            {t("workspacePolicy.noWorkspaces")}
          </FieldHint>
        )
      ) : null}
      {!valid ? (
        <FieldHint className="mt-0" tone="error">
          {t("workspacePolicy.pickOne")}
        </FieldHint>
      ) : null}
      {changed ? (
        <ButtonRow>
          <Button
            disabled={!valid || disabled || Boolean(action.running)}
            size="sm"
            variant="secondary"
            onClick={save}
          >
            {t("workspacePolicy.save")}
          </Button>
        </ButtonRow>
      ) : null}
      {action.running ? (
        <LoadingState
          className="text-xs leading-[1.6] wrap-anywhere"
          label={t("compute.saving")}
        />
      ) : null}
    </fieldset>
  );
}
