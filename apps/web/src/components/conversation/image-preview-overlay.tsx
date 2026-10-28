import { X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LocalImage } from "./local-image";
import { Button } from "../ui/button";
import type { ParsedImageTag } from "./conversation-types";

export function ImagePreviewOverlay({
  image,
  onClose,
}: {
  image: ParsedImageTag;
  onClose: () => void;
}) {
  const { t } = useTranslation("conversation");

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      aria-label={t("message.imagePreview")}
      aria-modal="true"
      className="fdy-image-preview"
      role="dialog"
    >
      <Button
        aria-label={t("message.closeImagePreview")}
        className="fdy-image-preview-backdrop"
        onClick={onClose}
        variant="ghost"
      />
      <div className="fdy-image-preview-panel">
        <div className="fdy-image-preview-topbar">
          <span>{image.alt}</span>
          <Button
            aria-label={t("message.closeImagePreview")}
            className="fdy-image-preview-close"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X size={18} />
          </Button>
        </div>
        <LocalImage
          alt={image.alt}
          key={image.source ?? image.path}
          path={image.path}
          presentation="overlay"
          source={image.source}
        />
      </div>
    </div>
  );
}
