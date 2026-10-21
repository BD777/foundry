import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NativeAccountInspection } from "@bd777/foundry-protocol";
import { ApiError } from "../../api/http";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import { inspectDeviceAccount } from "../../api";
import { AccountUsageWindows } from "../../components/account-usage-windows";
import { Button } from "../../components/ui/button";
import {
  accountUsageKey,
  type AccountUsageTarget,
} from "./chat-account-usage-model";
import "./chat-account-usage.css";

const ttlMs = 60_000;
export function ChatAccountUsage({
  target,
  completion,
}: {
  target: AccountUsageTarget;
  completion?: string;
}) {
  // The inner component's entire state belongs to one native identity.
  return (
    <AccountUsage
      key={accountUsageKey(target)}
      target={target}
      completion={completion}
    />
  );
}
function AccountUsage({
  target,
  completion,
}: {
  target: AccountUsageTarget;
  completion?: string;
}) {
  const { t, i18n } = useTranslation("profiles");
  const [result, setResult] = useState<NativeAccountInspection>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const pending = useRef(false);
  const checked = useRef(0);
  const mounted = useRef(true);
  const online = useRef(target.online);
  online.current = target.online;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(
    async (force = false) => {
      if (
        !online.current ||
        pending.current ||
        (!force && Date.now() - checked.current < ttlMs)
      )
        return;
      pending.current = true;
      setLoading(true);
      setFailed(false);
      try {
        const value = await inspectDeviceAccount(
          target.deviceId,
          target.runtime,
          undefined,
          {
            profileId: target.profileId,
            runtimeGeneration: target.generation,
            refresh: force,
          },
        );
        if (!mounted.current) return;
        if (value.runtimeGeneration !== target.generation) {
          setResult(undefined);
          setFailed(true);
          return;
        }
        checked.current = Date.now();
        setNow(Date.now());
        setResult(value);
      } catch (error) {
        if (mounted.current) {
          setFailed(true);
          if (
            error instanceof ApiError &&
            [401, 403, 404, 409].includes(error.status)
          )
            setResult(undefined);
        }
        // Back off automatic focus/completion retries, but keep the manual action available.
        checked.current = Date.now();
      } finally {
        pending.current = false;
        if (mounted.current) setLoading(false);
      }
    },
    [target.deviceId, target.generation, target.profileId, target.runtime],
  );
  useEffect(() => {
    void refresh();
  }, [refresh, target.online, completion]);
  useEffect(() => {
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    // Re-evaluate staleness only. This timer never starts a native process.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.removeEventListener("focus", focus);
      window.clearInterval(timer);
    };
  }, [refresh]);
  // A profile name/local_login alone does not prove subscription authentication.
  if (result?.authMode !== "subscription") return null;
  const age = now - Date.parse(result.checkedAt);
  const stale =
    failed ||
    !target.online ||
    !Number.isFinite(age) ||
    age >= ttlMs ||
    result.usage.some((w) => w.resetsAt && w.resetsAt * 1000 <= now);
  const windows = expanded ? result.usage : result.usage.slice(0, 2);
  const status = !target.online
    ? t("quota.offline")
    : failed
      ? t("quota.failed")
      : result.quotaReason === "renewal_pending"
        ? t("quota.renewal")
        : result.quotaStatus === "unsupported"
          ? t("quota.unsupported")
          : result.quotaStatus !== "supported"
            ? t("quota.unavailable")
            : stale
              ? t("quota.stale")
              : result.quotaMayBeCached
                ? t("quota.nativeSnapshot")
                : undefined;
  return (
    <section
      className="fdy-chat-context-section fdy-chat-account-usage"
      aria-label={t("quota.title")}
      aria-busy={loading}
    >
      <div className="fdy-chat-account-usage-heading">
        <h3 className="fdy-chat-account-usage-title">{t("quota.title")}</h3>
        <p
          className="fdy-chat-account-usage-caption"
          title={result.accountLabel}
        >
          {runtimeMeta(target.runtime).label}
          {result.plan ? ` · ${result.plan}` : ""} · {t("quota.accountScope")}
        </p>

        <Button
          size="icon"
          variant="ghost"
          disabled={loading || !target.online}
          onClick={() => void refresh(true)}
          aria-label={t("quota.refresh")}
          title={t("quota.refresh")}
        >
          <RefreshCw size={13} aria-hidden="true" />
        </Button>
      </div>
      {status ? (
        <p className="fdy-chat-account-usage-note" role="status">
          {status}
        </p>
      ) : null}
      <AccountUsageWindows
        windows={windows}
        compact
        footer={
          <small className="fdy-chat-account-usage-note">
            {t("quota.observed", {
              time: new Date(result.checkedAt).toLocaleTimeString(
                i18n.language,
                {
                  hour: "2-digit",
                  minute: "2-digit",
                },
              ),
            })}
          </small>
        }
      />
      {result.usage.length > 2 ? (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? t("quota.less")
            : t("quota.more", { count: result.usage.length - 2 })}
        </Button>
      ) : null}
    </section>
  );
}
