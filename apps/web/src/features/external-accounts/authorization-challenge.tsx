import { ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { apiBaseUrl } from "../../lib/api-base-url";
import { useCopied } from "../../lib/use-copied";

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
    <div className="fdy-xacc-scan">
      <div className="fdy-xacc-qr">
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
      <div className="fdy-xacc-code-copy">
        {children}
        {!validImage ? (
          <div className="fdy-xacc-code-actions">
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
          </div>
        ) : null}
        {challenge.userCode ? (
          <small className="fdy-xacc-user-code">
            {t("connect.userCode")} <code>{challenge.userCode}</code>
          </small>
        ) : null}
      </div>
    </div>
  );
}
