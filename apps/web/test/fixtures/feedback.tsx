/** Synthetic shared-primitives verification; no network writes. */
import { StrictMode, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { i18n } from "../../src/i18n";
import { Button } from "../../src/components/ui/button";
import { Alert } from "../../src/components/ui/alert";
import { FieldHint, TextInput } from "../../src/components/ui/field";
import { FieldHelp } from "../../src/components/ui/field-help";
import { RowMenu } from "../../src/components/ui/row-menu";
import {
  ToastProvider,
  ToastFeedback,
  useToast,
  type ToastTone,
} from "../../src/components/ui/toast";
import "../../src/styles.css";
import "./feedback-fixture.css";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") || "en");
document.documentElement.dataset.theme = params.get("theme") || "light";
function Fixture() {
  const notify = useToast();
  const [result, setResult] = useState("");
  const reject = useRef(true);
  const [feedback, setFeedback] = useState(false);
  return (
    <main className="fdy-feedback-fixture">
      <h1>Shared feedback and menus</h1>
      <p>
        Transient feedback floats. Page state and field guidance stay with their
        context.
      </p>
      <div className="fdy-feedback-fixture-actions">
        <Button
          onClick={() =>
            (["success", "warning", "error"] as ToastTone[]).forEach((tone) =>
              notify({
                title: `${tone} notification`,
                description:
                  "Synthetic action result. Composer and page dimensions remain unchanged.",
                tone,
                duration: Number(params.get("duration")) || 5000,
              }),
            )
          }
        >
          Show stack
        </Button>
        {(["success", "info", "warning", "error"] as ToastTone[]).map(
          (tone) => (
            <Button
              key={tone}
              onClick={() =>
                notify({
                  title: `${tone} notification`,
                  description:
                    "Synthetic action result. Composer and page dimensions remain unchanged.",
                  tone,
                  duration: Number(params.get("duration")) || 5000,
                })
              }
            >
              {tone}
            </Button>
          ),
        )}
        <Button
          onClick={() =>
            notify({
              title: "Archived 5 synthetic chats",
              tone: "success",
              action: {
                label: "Undo",
                onClick: async () => {
                  await new Promise((resolve) => setTimeout(resolve, 600));
                  if (reject.current) {
                    notify({
                      title: "Restore failed",
                      description:
                        "Synthetic connection failure. Retry Undo after enabling recovery.",
                      tone: "error",
                    });
                    throw new Error("Synthetic rejection");
                  }
                  setResult("Restored all 5 synthetic chats");
                },
              },
            })
          }
        >
          Action toast
        </Button>
        <Button
          onClick={() => {
            reject.current = false;
          }}
        >
          Enable recovery
        </Button>
        <Button onClick={() => setFeedback(true)}>State feedback</Button>
        {feedback ? (
          <ToastFeedback tone="success" title="Saved once in StrictMode" />
        ) : null}
        <RowMenu
          label="Row actions"
          items={[
            {
              key: "rename",
              label: "Rename",
              onSelect: () => setResult("Rename selected"),
            },
            {
              key: "archive",
              label: "Archive",
              onSelect: () => setResult("Archive selected"),
            },
            {
              key: "disabled",
              label: "Unavailable action",
              disabled: true,
              reason: "Stop this chat first.",
              onSelect: () => {},
            },
            {
              key: "delete",
              label: "Delete",
              tone: "danger",
              onSelect: () => setResult("Delete selected"),
            },
          ]}
        />
      </div>
      <Alert title="Persistent device status" tone="warning">
        The synthetic device is offline. This state remains visible until it
        reconnects.
      </Alert>
      <label htmlFor="fixture-name">
        Name{" "}
        <FieldHelp label="About this field">
          {i18n.t("account:page.languageHint")}
        </FieldHelp>
      </label>
      <TextInput
        id="fixture-name"
        aria-describedby="fixture-help"
        tone="boxed"
        placeholder="A field with shared guidance"
      />
      <FieldHint id="fixture-help">
        Shared help text uses the same spacing, font and color everywhere.
      </FieldHint>
      <TextInput
        aria-label="Composer"
        placeholder="Composer stays reachable"
        tone="boxed"
      />
      <Button>Send</Button>
      <output>{result}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <Fixture />
    </ToastProvider>
  </StrictMode>,
);
