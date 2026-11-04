import { ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { useCopied } from "../../lib/use-copied";
import { SignInModal } from "./sign-in";
import { FormLayout } from "../../components/ui/form-field";
import {
  codeCopyClass,
  qrClass,
  scanClass,
} from "../../components/device-sign-in/authorization-challenge";
import { ButtonRow } from "../../components/ui/button-row";

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
  const { copied, copy, reset } = useCopied();
  return (
    <SignInModal
      description={target?.description ?? ""}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
      open={Boolean(target)}
      title={target?.title ?? ""}
    >
      {target ? (
        <FormLayout>
          <div className={scanClass}>
            <div className={qrClass}>
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
            <div className={codeCopyClass}>
              <p>{t("linkQr.body")}</p>
              <ButtonRow className="max-[520px]:justify-center">
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
                  {copied()
                    ? t("common:actions.copied")
                    : t("connect.copyLink")}
                </Button>
              </ButtonRow>
            </div>
          </div>
        </FormLayout>
      ) : null}
    </SignInModal>
  );
}
