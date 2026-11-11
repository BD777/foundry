import { useTranslation } from "react-i18next";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { AppLink } from "../../components/ui/app-link";
import { buttonVariants } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import {
  deviceConcurrencyLimit,
  deviceConcurrencyMode,
} from "../../lib/device-concurrency";
import { deviceSettingsHref } from "../../lib/in-app-navigation";

/** One read-only line linking this workspace's device concurrency settings. */
export function WorkspaceConcurrencySummary({
  device,
}: {
  device?: DeviceProjection;
}) {
  const { t } = useTranslation("shell");
  const limit = device ? deviceConcurrencyLimit(device) : undefined;
  if (!device || limit === undefined) return null;
  const mode = deviceConcurrencyMode(device);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line-soft pt-3 text-sm text-ink-2">
      <span>
        {t("settings.concurrencyLimit", {
          limit,
          mode: t(`settings.concurrencyMode.${mode}`),
        })}
      </span>
      <AppLink
        className={cn(
          buttonVariants({ size: "sm", variant: "link" }),
          "ml-auto",
        )}
        href={deviceSettingsHref(device.id)}
      >
        {t("settings.openDeviceConcurrency", { device: device.label })}
      </AppLink>
    </div>
  );
}
