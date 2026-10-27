import { useTranslation } from "react-i18next";
import { deviceFileErrorMessage } from "./device-file-request";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";

export function FileReadFeedback({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <Alert
      className="fdy-chat-file-feedback"
      size="compact"
      title={t("detail.fileRead.failed")}
      tone="error"
    >
      <p>{deviceFileErrorMessage(error)}</p>
      {onRetry ? (
        <Button onClick={onRetry} size="sm">
          {t("detail.fileRead.retry")}
        </Button>
      ) : null}
    </Alert>
  );
}
