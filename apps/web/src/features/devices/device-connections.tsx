import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { setDeviceProfiles } from "../../api";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { Badge } from "../../components/ui/badge";
import { RuntimeMark } from "../../components/ui/runtime-mark";
import {
  connectionSelection,
  deviceConnectionSelection,
  isModelConnection,
} from "../../lib/model-connections";
import { ConnectionAssignmentDialog } from "./connection-assignment-dialog";

export function DeviceConnections({
  device,
  profiles,
  bindings,
  onRefresh,
  onManage,
}: {
  device: DeviceProjection;
  profiles: ProfileDefinition[];
  bindings: DeviceProfileBinding[];
  onRefresh: () => Promise<void>;
  onManage: () => void;
}) {
  const { t } = useTranslation("profiles");
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState("");
  // A write can land while the follow-up snapshot refresh fails. The change
  // is saved either way; those two outcomes are reported separately, so a
  // refresh hiccup can never look like the save was rolled back.
  const [refreshError, setRefreshError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const connections = profiles.filter(isModelConnection);
  const assigned = new Set(
    bindings
      .filter((row) => row.deviceId === device.id && row.enabled)
      .map((row) => row.profileId),
  );
  const assignedConnections = connections.filter((profile) =>
    assigned.has(profile.id),
  );
  const selectableIds = connections.map((profile) => profile.id);

  async function refreshAfterWrite() {
    setRefreshing(true);
    setRefreshError("");
    try {
      await onRefresh();
      setSavedNote(false);
    } catch (cause) {
      setRefreshError(
        cause instanceof Error
          ? cause.message
          : t("deviceConnections.refreshFailed"),
      );
    } finally {
      setRefreshing(false);
    }
  }

  /** Runs one write. Returns an error message on failure so the caller can
   *  react, or undefined once it landed. A successful write is followed by a
   *  refresh whose own failure never re-surfaces as a write failure.
   *  `surfaceError` controls the section-level alert: the picker passes false
   *  because it owns its own inline error — the same failure must not appear
   *  twice, or linger in the section after the picker closes. */
  async function commitWrite(
    action: () => Promise<unknown>,
    { surfaceError = true }: { surfaceError?: boolean } = {},
  ): Promise<string | undefined> {
    setBusy(true);
    setWriteError("");
    try {
      await action();
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : t("deviceConnections.saveFailed");
      if (surfaceError) setWriteError(message);
      setBusy(false);
      return message;
    }
    setBusy(false);
    setSavedNote(true);
    void refreshAfterWrite();
    return undefined;
  }

  return (
    <section className="fdy-device-section">
      <header className="fdy-management-heading">
        <div>
          <h2>{t("deviceConnections.title")}</h2>
          <p>{t("deviceConnections.intro")}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setPickerOpen(true)}
        >
          {t("deviceConnections.add")}
        </Button>
      </header>
      {savedNote && !refreshError ? (
        <p role="status">
          {refreshing
            ? t("deviceConnections.savedRefreshing")
            : t("deviceConnections.saved")}
        </p>
      ) : null}
      {assignedConnections.map((profile) => (
        <div className="fdy-management-row" key={profile.id}>
          <RuntimeMark runtime={profile.runtime} />
          <span>
            <strong>{profile.label}</strong>
            <small>
              {t(
                profile.hasCredential
                  ? "deviceConnections.storedOnServer"
                  : "deviceConnections.storedOnServerNoKey",
                { detail: profile.model || profile.baseUrl },
              )}
            </small>
          </span>
          <Badge tone="neutral">{t("deviceConnections.assigned")}</Badge>
          <ConfirmButton
            confirmLabel={t("deviceConnections.removeConfirm", {
              connection: profile.label,
              device: device.label,
            })}
            disabled={busy}
            onConfirm={() =>
              void commitWrite(() =>
                setDeviceProfiles({
                  deviceId: device.id,
                  profileIds: connectionSelection(
                    bindings,
                    device.id,
                    profile.id,
                    false,
                  ),
                }),
              )
            }
            size="sm"
            variant="secondary"
          >
            {t("deviceConnections.removeAccess")}
          </ConfirmButton>
        </div>
      ))}
      {assignedConnections.length === 0 ? (
        <p>{t("deviceConnections.none")}</p>
      ) : null}
      <Button
        className="fdy-account-inline-action"
        size="sm"
        variant="ghost"
        onClick={onManage}
      >
        {t("deviceConnections.manage")}
      </Button>
      {writeError ? <p role="alert">{writeError}</p> : null}
      {refreshError ? (
        <div className="fdy-connection-refresh-error" role="alert">
          <span>
            {t("deviceConnections.refreshFailedDetail", {
              error: refreshError,
            })}
          </span>
          <Button
            disabled={refreshing}
            onClick={() => void refreshAfterWrite()}
            size="sm"
            variant="secondary"
          >
            {refreshing
              ? t("deviceConnections.retrying")
              : t("deviceConnections.retryRefresh")}
          </Button>
        </div>
      ) : null}
      <ConnectionAssignmentDialog
        connections={connections}
        initialSelectedIds={connections
          .map((profile) => profile.id)
          .filter((id) => assigned.has(id))}
        onManage={onManage}
        onOpenChange={setPickerOpen}
        onSave={async (selectedIds) => {
          // Only the write decides dialog success. The post-save refresh is
          // owned by the section: if it fails, the picker still closed (the
          // assignment was saved) and the section offers a refresh-only retry.
          const failure = await commitWrite(
            () =>
              setDeviceProfiles({
                deviceId: device.id,
                profileIds: deviceConnectionSelection(
                  bindings,
                  device.id,
                  selectableIds,
                  selectedIds,
                ),
              }),
            { surfaceError: false },
          );
          if (failure) throw new Error(failure);
        }}
        open={pickerOpen}
      />
    </section>
  );
}
