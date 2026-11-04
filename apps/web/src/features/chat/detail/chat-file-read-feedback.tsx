import { useTranslation } from "react-i18next";
import { deviceFileErrorMessage } from "./device-file-request";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";

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
      className="max-w-full min-w-0"
      size="compact"
      title={t("detail.fileRead.failed")}
      tone="error"
      actions={
        onRetry ? (
          <Button onClick={onRetry} size="sm">
            {t("detail.fileRead.retry")}
          </Button>
        ) : undefined
      }
    >
      <p>{deviceFileErrorMessage(error)}</p>
    </Alert>
  );
}
