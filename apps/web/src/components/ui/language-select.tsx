import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { locales, type LocalePreference } from "../../i18n";
import { SelectMenu } from "./select-menu";

/** Choose the interface language, or follow the browser. */
export function LanguageSelect({
  className,
  compact = false,
  disabled,
  onChange,
  value,
}: {
  className?: string;
  /** Icon-only trigger for a toolbar; the open menu shows full names. */
  compact?: boolean;
  disabled?: boolean;
  onChange: (value: LocalePreference) => void;
  value: LocalePreference;
}) {
  const { t } = useTranslation();
  return (
    <SelectMenu
      ariaLabel={t("language.label")}
      className={className}
      tone={compact ? "icon" : "field"}
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
