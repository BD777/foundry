import { ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { SignInModal } from "./sign-in";

export interface LinkQrTarget {
  title: string;
  description: string;
  url: string;
}

/**
 * A Feishu page the person may open where they are signed in: on this
 * computer through the link, or on their phone through the QR code.
 */
export function LinkQrDialog({
  target,
  onClose,
}: {
  target?: LinkQrTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [copied, setCopied] = useState(false);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <SignInModal
      description={target?.description ?? ""}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
      open={Boolean(target)}
      title={target?.title ?? ""}
    >
      {target ? (
        <div className="fdy-xacc-form">
          <div className="fdy-xacc-scan">
            <div className="fdy-xacc-qr">
              <QRCodeSVG
                bgColor="#ffffff"
                fgColor="#111111"
                level="M"
                marginSize={2}
                size={176}
                title={t("connect.qrTitle")}
                value={target.url}
              />
            </div>
            <div className="fdy-xacc-code-copy">
              <p>{t("linkQr.body")}</p>
              <div className="fdy-xacc-code-actions">
                <Button asChild size="sm" variant="primary">
                  <a href={target.url} rel="noreferrer" target="_blank">
                    <ExternalLink size={14} />
                    {t("connect.openPage")}
                  </a>
                </Button>
                <Button
                  onClick={() => void copy(target.url)}
                  size="sm"
                  variant="ghost"
                >
                  {copied ? t("common:actions.copied") : t("connect.copyLink")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </SignInModal>
  );
}
