import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { locales, type LocalePreference } from "../../i18n";
import { SelectMenu } from "./select-menu";

/** Choose the interface language, or follow the browser. */
export function LanguageSelect({
  className,
  disabled,
  onChange,
  value,
}: {
  className?: string;
  disabled?: boolean;
  onChange: (value: LocalePreference) => void;
  value: LocalePreference;
}) {
  const { t } = useTranslation();
  return (
    <SelectMenu
      ariaLabel={t("language.label")}
      className={className}
      disabled={disabled}
      onChange={(next) => onChange(next as LocalePreference)}
      renderTriggerPrefix={() => <Languages aria-hidden size={14} />}
      options={[
        { label: t("language.followBrowser"), value: "" },
        ...locales.map((locale) => ({
          label: t(`language.${locale}`),
          value: locale,
        })),
      ]}
      value={value}
    />
  );
}
