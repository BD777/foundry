import { ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { apiBaseUrl } from "../../lib/api-base-url";
import { useCopied } from "../../lib/use-copied";
import { ButtonRow } from "../ui/button-row";

/** Common presentation contract. Adapters keep their existing begin/poll APIs,
 * ownership checks and credential storage; the Web only receives a challenge. */
export interface ConnectorAuthorizationChallenge {
  operationId: string;
  verificationUrl: string;
  imageUrl?: string;
  userCode?: string;
  expiresAt?: string;
  intervalSeconds?: number;
}

/** The QR beside what to do with it; stacked and centred when narrow. */
export const scanClass =
  "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4 max-[520px]:grid-cols-[minmax(0,1fr)] max-[520px]:justify-items-center max-[520px]:text-center";
/** Dark modules on a light ground in both themes: phone cameras read that. */
export const qrClass =
  "fdy-xacc-qr grid rounded-lg border border-line-soft bg-(--fdy-qr-surface) p-1.5 leading-[0]";
export const codeCopyClass =
  "grid gap-1 [&>p]:text-xs [&>p]:leading-normal [&>p]:text-ink-muted [&>strong]:text-md [&>strong]:text-ink";

export function AuthorizationChallenge({
  challenge,
  active,
  children,
  onImageError,
}: {
  challenge: ConnectorAuthorizationChallenge;
  active: boolean;
  children?: ReactNode;
  onImageError?: () => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const { copied, copy } = useCopied();
  let safe = false;
  try {
    const url = new URL(challenge.verificationUrl);
    safe = url.protocol === "https:" && !url.username && !url.password;
  } catch {
    /* Invalid challenges are never made clickable. */
  }
  const imagePath = challenge.imageUrl;
  const validImage =
    !!imagePath &&
    /^\/api\/devices\/[^/]+\/connectors\/[^/]+\/sign-in\/image\?/.test(
      imagePath,
    ) &&
    new URL(imagePath, "https://foundry.invalid").searchParams.get(
      "operationId",
    ) === challenge.operationId;
  if (
    !active ||
    (!safe && !validImage) ||
    !challenge.operationId ||
    (challenge.expiresAt && Date.now() >= Date.parse(challenge.expiresAt))
  )
    return null;
  return (
    <div className={scanClass}>
      <div className={qrClass}>
        {validImage ? (
          <img
            className="fdy-xacc-auth-image"
            src={`${apiBaseUrl}${imagePath}`}
            alt={t("authorization.nativeQr")}
            width={176}
            height={176}
            referrerPolicy="no-referrer"
            onError={onImageError}
          />
        ) : (
          <QRCodeSVG
            bgColor="#ffffff"
            fgColor="#111111"
            level="M"
            marginSize={2}
            size={176}
            title={t("connect.qrTitle")}
            value={challenge.verificationUrl}
          />
        )}
      </div>
      <div className={codeCopyClass}>
        {children}
        {!validImage ? (
          <ButtonRow className="max-[520px]:justify-center">
            <Button asChild size="sm" variant="primary">
              <a
                href={challenge.verificationUrl}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink size={14} />
                {t("connect.openPage")}
              </a>
            </Button>
            <Button
              onClick={() => void copy(challenge.verificationUrl)}
              size="sm"
              variant="ghost"
            >
              {copied() ? t("common:actions.copied") : t("connect.copyLink")}
            </Button>
          </ButtonRow>
        ) : null}
        {challenge.userCode ? (
          <small className="fdy-xacc-user-code inline-flex items-center gap-2 text-xs text-ink-muted [&_code]:rounded-sm [&_code]:bg-panel-soft [&_code]:px-2 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-md [&_code]:text-ink">
            {t("connect.userCode")} <code>{challenge.userCode}</code>
          </small>
        ) : null}
      </div>
    </div>
  );
}
