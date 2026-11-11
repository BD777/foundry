import { useTranslation } from "react-i18next";
import type { ProfileDefinition } from "@bd777/foundry-protocol";

/** Server requests the page also hears about, and changes it announces. */
export function useProfileRequests({
  notify,
  changed,
}: {
  notify: (message: string, tone?: "error") => void;
  changed: () => Promise<void> | void;
}) {
  const { t } = useTranslation("profiles");
  // A server request the page also hears about when it fails.
  async function request<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (error) {
      notify(t("page.saveFailed"), "error");
      throw error;
    }
  }
  // A change is shown once the page has read it, then the page says so.
  function change(
    send: () => Promise<ProfileDefinition>,
    notice: (label: string) => string,
  ): Promise<ProfileDefinition> {
    return request(async () => {
      const profile = await send();
      await changed();
      notify(notice(profile.label));
      return profile;
    });
  }
  return { request, change };
}
