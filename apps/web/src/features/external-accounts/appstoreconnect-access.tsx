import type {
  ExternalAccessLevel,
  ExternalAccount,
} from "@bd777/foundry-protocol";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { CheckLabel } from "../../components/ui/check-label";
import { FieldHint, Radio } from "../../components/ui/field";

const levels: ExternalAccessLevel[] = [{ name: "read" }, { name: "commerce" }];

export function AppStoreConnectAccessLevels({
  account,
  value,
  disabled,
  onChange,
}: {
  account: ExternalAccount;
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
      {levels.map((level) => (
        <CheckLabel key={level.name}>
          <Radio
            checked={value === level.name}
            disabled={disabled}
            name={`${name}:${account.id}`}
            value={level.name}
            onChange={() => onChange(level.name)}
          />
          <span>
            <strong>
              {t(
                level.name === "commerce"
                  ? "appstoreconnect.accessCommerce"
                  : "appstoreconnect.accessRead",
              )}
            </strong>
            <small>
              {t(
                level.name === "commerce"
                  ? "appstoreconnect.accessCommerceDetail"
                  : "appstoreconnect.accessReadDetail",
              )}
            </small>
          </span>
        </CheckLabel>
      ))}
    </fieldset>
  );
}
