/** Real HTTP cache fixture. The test server serves a synthetic image only. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreview } from "../../src/components/conversation/local-image";
import { LocalImage } from "../../src/components/conversation/local-image";
import { Button } from "../../src/components/ui/button";
import { i18n } from "../../src/i18n";
import "../../src/styles.css";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") || "en");
document.documentElement.dataset.theme = params.get("theme") || "light";
function Fixture() {
  const [visible, setVisible] = useState(true);
  const [open, setOpen] = useState(false);
  const path = `/synthetic/.foundry/attachments/${params.get("image") || "cache"}.png`;
  return (
    <main className="mx-auto max-w-[1040px] p-6">
      <h1 className="text-2xl">DEV-051 · HTTP cache</h1>
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
        <ImagePreview
          image={{ path, alt: "Synthetic cached screenshot" }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
