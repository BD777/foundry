import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, UsersRound } from "lucide-react";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { dismissSystemAccountNotice } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Popover } from "../../components/ui/popover";
import {
  accountSharers,
  firstAcceptedShare,
  joinNames,
  pendingAccountShareNotices,
} from "../../lib/device-sharing";
import { serverErrorText } from "../../lib/errors";
import { dateOnly } from "../../lib/time-format";

/** The notice belongs to this exact device identity, independently of its label. */
function useShareNotice(
  device: DeviceProjection,
  onRefresh: () => Promise<void>,
) {
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState("");
  const [error, setError] = useState<{ message: string; afterSave: boolean }>();
  const signature = JSON.stringify([
    device.id,
    device.sharesSystemAccountWith
      ?.filter((s) => s.noticePending)
      .map((s) => [s.deviceId, s.acceptedAt])
      .sort(),
  ]);
  const pending =
    device.owned === true &&
    pendingAccountShareNotices([device]).length > 0 &&
    acknowledged !== signature;
  const saved = acknowledged === signature;
  async function run(dismiss: boolean) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    let afterSave = !dismiss;
    try {
      if (dismiss) {
        await dismissSystemAccountNotice(device.id);
        setAcknowledged(signature);
        afterSave = true;
      }
      await onRefresh();
    } catch (reason) {
      setError({ message: serverErrorText(reason), afterSave });
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    pending,
    saved,
    confirm: () => run(true),
    retryRefresh: () => run(false),
  };
}
type NoticeState = ReturnType<typeof useShareNotice>;

/** Card affordance is a sibling of the navigation button, never nested in it. */
export function AccountShareIcon({
  device,
  onRefresh,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("devices");
  const notice = useShareNotice(device, onRefresh);
  if (!accountSharers(device).length) return null;
  const label = t(
    notice.pending ? "accountShare.unreadFor" : "accountShare.detailsFor",
    { device: device.label },
  );
  const Icon = notice.pending ? CircleAlert : UsersRound;
  return (
    <Popover
      openOnHover
      label={t("accountShare.detailsFor", { device: device.label })}
      className="fdy-account-share-popover"
      trigger={
        <Button
          variant="icon"
          size="icon"
          className="fdy-account-share-trigger"
          aria-label={label}
        >
          <Icon size={18} aria-hidden="true" />
        </Button>
      }
    >
      <strong>{device.label}</strong>
      <AccountShareFacts device={device} />
      <ShareNoticeAction notice={notice} />
    </Popover>
  );
}

/** Same facts in the popover and full device details, without duplicate alerts. */
export function AccountShareExplanation({
  device,
  onRefresh,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation("devices");
  const notice = useShareNotice(device, onRefresh);
  const names = accountSharers(device);
  if (!names.length) return null;
  return (
    <Alert
      title={t("accountShare.label", {
        names: joinNames(names, i18n.language),
      })}
    >
      <AccountShareFacts device={device} />
      <ShareNoticeAction notice={notice} />
    </Alert>
  );
}

function AccountShareFacts({ device }: { device: DeviceProjection }) {
  const { t, i18n } = useTranslation("devices");
  const names = accountSharers(device),
    accepted = firstAcceptedShare(device);
  return (
    <div className="fdy-account-share-facts">
      <p>
        {t("accountShare.body", {
          names: joinNames(names, i18n.language),
          count: names.length,
        })}
      </p>
      <p>
        {accepted?.acceptedAt
          ? accepted.acceptedBy
            ? t("accountShare.chosen", {
                date: dateOnly(accepted.acceptedAt),
                acceptedBy: accepted.acceptedBy,
              })
            : t("accountShare.acceptedOn", {
                date: dateOnly(accepted.acceptedAt),
              })
          : t("accountShare.noticed", { count: names.length })}
      </p>
    </div>
  );
}

function ShareNoticeAction({ notice }: { notice: NoticeState }) {
  const { t } = useTranslation("devices");
  return (
    <>
      {notice.pending ? (
        <div className="fdy-account-share-actions">
          <p>{t("accountShare.noticeTitle")}</p>
          <Button
            size="sm"
            disabled={notice.busy}
            aria-busy={notice.busy}
            onClick={() => void notice.confirm()}
          >
            {notice.busy
              ? t("accountShare.dismissing")
              : t("accountShare.dismiss")}
          </Button>
        </div>
      ) : notice.saved ? (
        <ToastFeedback tone="success" title={t("accountShare.read")} />
      ) : null}
      {notice.error && !notice.error.afterSave ? (
        <ToastFeedback tone="error" title={t("accountShare.dismissFailed")}>
          {notice.error.message}
        </ToastFeedback>
      ) : notice.error ? (
        <Alert
          tone="error"
          title={t(
            notice.error.afterSave
              ? "accountShare.refreshFailed"
              : "accountShare.dismissFailed",
          )}
        >
          <p>{notice.error.message}</p>
          {notice.error.afterSave ? (
            <Button
              size="sm"
              disabled={notice.busy}
              onClick={() => void notice.retryRefresh()}
            >
              {t("list.refresh")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
    </>
  );
}
