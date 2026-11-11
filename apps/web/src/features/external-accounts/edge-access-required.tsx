import type { EdgeAccessRequired } from "@bd777/foundry-protocol";
import { ArrowRight, WandSparkles } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  provisionEdgeAccess,
  type EdgeAccessProvisionResult,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { AppLink } from "../../components/ui/app-link";
import { Button } from "../../components/ui/button";
import { FieldHint } from "../../components/ui/field";
import {
  connectorsHref,
  navigateToEdgeAccessCredential,
} from "../../lib/in-app-navigation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reads the structured edge details the connector probe put on a 400. */
export function edgeAccessRequiredOf(
  cause: unknown,
): EdgeAccessRequired | undefined {
  const value = cause instanceof ApiError ? cause.details?.edgeAccess : null;
  if (
    !(cause instanceof ApiError) ||
    cause.code !== "edge_access_required" ||
    !isRecord(value)
  )
    return undefined;
  if (
    typeof value.provider !== "string" ||
    typeof value.host !== "string" ||
    typeof value.path !== "string" ||
    typeof value.message !== "string"
  )
    return undefined;
  return value as EdgeAccessRequired;
}

/** A rejected connector probe that Cloudflare Access stands in front of. */
export function EdgeAccessRequiredNotice({
  onProvisioned,
  required,
}: {
  onProvisioned?: (result: EdgeAccessProvisionResult) => void;
  required: EdgeAccessRequired;
}) {
  const { t } = useTranslation("externalAccounts");
  const detailID = useId();
  const [provisioning, setProvisioning] = useState(false);
  const [provisioned, setProvisioned] = useState<EdgeAccessProvisionResult>();
  const [provisionError, setProvisionError] = useState<unknown>();
  const zeroTrustRequired =
    provisionError instanceof ApiError &&
    provisionError.code === "cloudflare_zero_trust_required";

  async function provision() {
    if (provisioning || provisioned) return;
    setProvisioning(true);
    setProvisionError(undefined);
    try {
      const result = await provisionEdgeAccess(required);
      setProvisioned(result);
      onProvisioned?.(result);
    } catch (cause) {
      setProvisionError(cause);
    } finally {
      setProvisioning(false);
    }
  }

  if (provisioned) {
    const ingress = provisioned.suggestedIngress;
    return (
      <Alert
        data-edge-access-provisioned
        title={t("edgeAccessRequired.provisioned", {
          name: provisioned.serviceTokenName,
        })}
        tone="success"
      >
        <p>
          {t("edgeAccessRequired.provisionedDetail", {
            host: required.host,
            path: required.path,
          })}
        </p>
        {provisioned.needsIngress ? (
          <div className="mt-2 grid gap-1.5">
            <strong>{t("edgeAccessRequired.ingressMissing")}</strong>
            {ingress ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt>{t("edgeAccessRequired.ingressHostname")}</dt>
                <dd className="m-0 min-w-0">
                  <code className="wrap-anywhere">{ingress.hostname}</code>
                </dd>
                <dt>{t("edgeAccessRequired.ingressPath")}</dt>
                <dd className="m-0 min-w-0">
                  <code className="wrap-anywhere">
                    {ingress.path || t("edgeAccessRequired.ingressWholeHost")}
                  </code>
                </dd>
                <dt>{t("edgeAccessRequired.ingressService")}</dt>
                <dd className="m-0 min-w-0">
                  <code className="wrap-anywhere">{ingress.service}</code>
                </dd>
              </dl>
            ) : null}
            {ingress?.note ? <span>{ingress.note}</span> : null}
          </div>
        ) : null}
      </Alert>
    );
  }

  return (
    <Alert
      actions={
        <>
          <Button
            onClick={() =>
              navigateToEdgeAccessCredential(required.host, required.path)
            }
            size="sm"
            variant="primary"
          >
            {t("edgeAccessRequired.addCredential")}
          </Button>
          <Button
            aria-describedby={detailID}
            busy={provisioning}
            onClick={() => void provision()}
            size="sm"
            variant="secondary"
          >
            <WandSparkles aria-hidden="true" size={14} />
            {provisioning
              ? t("edgeAccessRequired.provisioning")
              : t("edgeAccessRequired.provision")}
          </Button>
        </>
      }
      data-edge-access-required
      title={
        required.team
          ? t("edgeAccessRequired.withTeam", { team: required.team })
          : t("edgeAccessRequired.withoutTeam")
      }
      tone="warning"
    >
      <FieldHint as="div" className="mt-0" id={detailID}>
        {t("edgeAccessRequired.provisionDetail")}
      </FieldHint>
      {zeroTrustRequired ? (
        <div className="mt-2 grid gap-2">
          <span>{t("edgeAccessRequired.zeroTrustRequired")}</span>
          <Button asChild className="w-fit" size="sm" variant="secondary">
            <AppLink href={connectorsHref("cloudflare")}>
              {t("edgeAccessRequired.authorizeZeroTrust")}
              <ArrowRight aria-hidden="true" size={14} />
            </AppLink>
          </Button>
        </div>
      ) : provisionError ? (
        <span className="mt-2 block">
          {t("edgeAccessRequired.provisionFailed", {
            error:
              provisionError instanceof Error
                ? provisionError.message
                : String(provisionError),
          })}
        </span>
      ) : null}
    </Alert>
  );
}
