import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectorAuthorizationGroup } from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
import { CheckLabel } from "../../components/ui/check-label";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { MutedText } from "../../components/ui/text";
import { localized } from "./connector-text";

export function AuthorizationScopePicker({
  group,
  granted = [],
  onStart,
}: {
  group: ConnectorAuthorizationGroup;
  granted?: string[];
  onStart: (options: Record<string, string>) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const scopes = group.scopes ?? [];
  const recommended = scopes
    .filter((s) => s.required || s.recommended)
    .map((s) => s.id);
  const [mode, setMode] = useState("recommended");
  const [selected, setSelected] = useState(recommended);
  return (
    <div className="grid gap-4">
      <SegmentedControl
        aria-label={t("authorization.permissions")}
        value={mode}
        fill
        options={[
          { value: "recommended", label: t("authorization.recommended") },
          { value: "custom", label: t("authorization.custom") },
          { value: "all", label: t("authorization.allListed") },
        ]}
        onValueChange={(value) => {
          setMode(value);
          if (value === "recommended") setSelected(recommended);
          if (value === "all") setSelected(scopes.map((s) => s.id));
        }}
      />
      <div className="grid gap-3">
        {scopes.map((scope) => (
          <CheckLabel key={scope.id}>
            <Checkbox
              checked={selected.includes(scope.id)}
              disabled={!!scope.required}
              onChange={(event) => {
                setMode("custom");
                setSelected(
                  event.target.checked
                    ? [...selected, scope.id]
                    : selected.filter((id) => id !== scope.id),
                );
              }}
            />
            <span>
              {localized(scope.label, scope.labels)}
              <small>
                {scope.id}
                {granted.includes(scope.id)
                  ? ` · ${t("authorization.granted")}`
                  : ""}
              </small>
            </span>
          </CheckLabel>
        ))}
      </div>
      <MutedText>{t("authorization.additive")}</MutedText>
      <Button
        variant="primary"
        disabled={!selected.length}
        onClick={() => onStart({ scopes: selected.join(",") })}
      >
        {t("authorization.authorizeSelected")}
      </Button>
    </div>
  );
}
