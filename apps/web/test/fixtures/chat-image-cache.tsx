/** Real HTTP cache fixture. The test server serves a synthetic image only. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreviewOverlay } from "../../src/components/conversation/image-preview-overlay";
import { LocalImage } from "../../src/components/conversation/local-image";
import { Button } from "../../src/components/ui/button";
import { i18n } from "../../src/i18n";
import "../../src/styles.css";
import "./chat-images.css";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") || "en");
document.documentElement.dataset.theme = params.get("theme") || "light";
function Fixture() {
  const [visible, setVisible] = useState(true);
  const [open, setOpen] = useState(false);
  const path = `/synthetic/.foundry/attachments/${params.get("image") || "cache"}.png`;
  return (
    <main className="fdy-chat-images-fixture">
      <h1>DEV-051 · HTTP cache</h1>
      <Button onClick={() => setVisible(!visible)}>
        {visible ? "Hide image" : "Show image"}
      </Button>
      {visible ? (
        <LocalImage
          path={path}
          onPreview={() => setOpen(true)}
          alt="Synthetic cached screenshot"
        />
      ) : null}
      {open ? (
        <ImagePreviewOverlay
          image={{ path, alt: "Synthetic cached screenshot" }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
