import type {
  ExternalAccessLevel,
  ExternalAccount,
} from "@bd777/foundry-protocol";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { CheckLabel } from "../../components/ui/check-label";
import { FieldHint, Radio } from "../../components/ui/field";
import { accessLevelWords } from "./connector-text";

/** The workspace's App Store Connect access level, one radio per level the
 * server's access file lists. */
export function AppStoreConnectAccessLevels({
  account,
  levels,
  value,
  disabled,
  onChange,
}: {
  account: ExternalAccount;
  levels: ExternalAccessLevel[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const name = useId();
  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-0.5 text-sm font-semibold">
        {t("appstoreconnect.accessTitle")}
      </legend>
      <FieldHint>{t("appstoreconnect.accessDetail")}</FieldHint>
      {levels.map((level) => {
        const words = accessLevelWords(levels, level.name);
        return (
          <CheckLabel key={level.name}>
            <Radio
              checked={value === level.name}
              disabled={disabled}
              name={`${name}:${account.id}`}
              value={level.name}
              onChange={() => onChange(level.name)}
            />
            <span>
              <strong>{words.label}</strong>
              <small>{words.description}</small>
            </span>
          </CheckLabel>
        );
      })}
    </fieldset>
  );
}
