import { useState } from "react";
import { updateMyLocale } from "../api";
import { LanguageSelect } from "../components/ui/language-select";
import { applyLocalePreference, type LocalePreference } from "../i18n";
import { useAccountSession } from "./accounts-gate";

/**
 * The interface language beside the theme button. The choice applies at once
 * and is saved to the account, as on the Account page.
 */
export function SidebarLanguage({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const session = useAccountSession();
  const [busy, setBusy] = useState(false);

  async function choose(locale: LocalePreference): Promise<void> {
    setBusy(true);
    try {
      await applyLocalePreference(locale);
      if (session.user) session.replaceUser(await updateMyLocale(locale));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <LanguageSelect
      compact
      disabled={busy}
      onChange={(locale) => void choose(locale)}
      value={session.user?.locale ?? ""}
    />
  );
}
