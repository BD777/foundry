import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { dismissSystemAccountNotice } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  accountSharers,
  firstAcceptedShare,
  joinNames,
  pendingAccountShareNotices,
  type AccountShareNotice,
} from "../../lib/device-sharing";
import { serverErrorText } from "../../lib/errors";
import { dateOnly } from "../../lib/time-format";

/**
 * Other people's devices run under this device's system account: they share
 * its files and Claude/Codex sign-ins. Labelled as sharing someone chose,
 * never as isolation.
 */
export function AccountShareLabel({ device }: { device: DeviceProjection }) {
  const { t, i18n } = useTranslation("devices");
  const names = accountSharers(device);
  if (!names.length) return null;
  return (
    <Badge tone="neutral">
      {t("accountShare.label", { names: joinNames(names, i18n.language) })}
    </Badge>
  );
}

/** On the device's page: who shares its account, what that means, since when. */
export function AccountShareExplanation({
  device,
}: {
  device: DeviceProjection;
}) {
  const { t, i18n } = useTranslation("devices");
  const names = accountSharers(device);
  if (!names.length) return null;
  const joined = joinNames(names, i18n.language);
  const accepted = firstAcceptedShare(device);
  return (
    <Alert title={t("accountShare.label", { names: joined })}>
      <p>{t("accountShare.body", { names: joined, count: names.length })}</p>
      <p>
        {accepted?.acceptedAt
          ? t("accountShare.chosen", {
              date: dateOnly(accepted.acceptedAt),
              acceptedBy: accepted.acceptedBy ?? accepted.ownerName,
            })
          : t("accountShare.noticed", { count: names.length })}
      </p>
    </Alert>
  );
}

/**
 * The one notice for the owner who was there first: someone else now uses
 * the system account of their device. "Got it" dismisses it; the label stays.
 */
export function AccountShareNotices({
  devices,
  onRefresh,
}: {
  devices: readonly DeviceProjection[];
  onRefresh: () => Promise<void>;
}) {
  const notices = pendingAccountShareNotices(devices);
  if (!notices.length) return null;
  return (
    <>
      {notices.map((notice) => (
        <AccountShareNoticeAlert
          key={notice.device.id}
          notice={notice}
          onRefresh={onRefresh}
        />
      ))}
    </>
  );
}

function AccountShareNoticeAlert({
  notice,
  onRefresh,
}: {
  notice: AccountShareNotice;
  onRefresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation("devices");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function dismiss(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await dismissSystemAccountNotice(notice.device.id);
      await onRefresh();
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Alert tone="warning" title={t("accountShare.noticeTitle")}>
        <p>
          {t("accountShare.notice", {
            names: joinNames(notice.names, i18n.language),
            count: notice.names.length,
            device: notice.device.label,
          })}
        </p>
        <div className="fdy-account-share-actions">
          <Button
            aria-busy={busy}
            disabled={busy}
            onClick={() => void dismiss()}
            size="sm"
          >
            {busy ? t("accountShare.dismissing") : t("accountShare.dismiss")}
          </Button>
        </div>
      </Alert>
      {error ? (
        <Alert tone="error" title={t("accountShare.dismissFailed")}>
          {error}
        </Alert>
      ) : null}
    </>
  );
}
