import type {
  AppStoreConnectConnection,
  SaveAppStoreConnectKeyInput,
} from "@bd777/foundry-protocol";
import { FileKey2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createAppStoreConnectKey, replaceAppStoreConnectKey } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { Dialog } from "../../components/ui/dialog";
import {
  FieldHint,
  FileInput,
  Textarea,
  TextInput,
} from "../../components/ui/field";
import {
  FormField,
  FormFieldGroup,
  FormLayout,
} from "../../components/ui/form-field";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { errorText } from "./account-format";

type SecretSource = "file" | "paste";
type KeyIssue = "issuer" | "key" | "privateKey";

const issuerPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9]{8,16}$/;

export function AppStoreConnectKeyDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection?: AppStoreConnectConnection;
  onClose: () => void;
  onSaved: (connection: AppStoreConnectConnection) => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [source, setSource] = useState<SecretSource>("file");
  const [issuerId, setIssuerId] = useState(connection?.issuerId ?? "");
  const [keyId, setKeyId] = useState(connection?.keyId ?? "");
  const [label, setLabel] = useState(connection?.label ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [fileName, setFileName] = useState("");
  const [issues, setIssues] = useState<Partial<Record<KeyIssue, string>>>({});
  const [fileError, setFileError] = useState("");
  const [error, setError] = useState("");
  const [discarded, setDiscarded] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const replacing = Boolean(connection);

  function validate(): boolean {
    const next: Partial<Record<KeyIssue, string>> = {};
    if (!issuerPattern.test(issuerId.trim()))
      next.issuer = t("appstoreconnect.errors.issuer");
    if (!keyPattern.test(keyId.trim()))
      next.key = t("appstoreconnect.errors.keyId");
    if (
      !privateKey.trim() ||
      !privateKey.includes("BEGIN PRIVATE KEY") ||
      !privateKey.includes("END PRIVATE KEY")
    )
      next.privateKey = t("appstoreconnect.errors.privateKey");
    setIssues(next);
    return Object.keys(next).length === 0;
  }

  async function submit(event: FormEvent<HTMLElement>) {
    event.preventDefault();
    setError("");
    setFileError("");
    if (!validate()) return;
    const input: SaveAppStoreConnectKeyInput = {
      issuerId: issuerId.trim(),
      keyId: keyId.trim(),
      privateKey,
      label: label.trim(),
    };
    // The .p8 lives only in this request. Clear it before the network wait so
    // neither a successful nor a failed answer leaves it in the page.
    setPrivateKey("");
    setFileName("");
    setDiscarded(true);
    if (fileInput.current) fileInput.current.value = "";
    setBusy(true);
    try {
      const pending = connection
        ? replaceAppStoreConnectKey(connection.appId, input)
        : createAppStoreConnectKey(input);
      input.privateKey = "";
      const saved = await pending;
      onSaved(saved);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t(
        replacing ? "appstoreconnect.replaceTitle" : "appstoreconnect.addTitle",
      )}
      description={t(
        replacing
          ? "appstoreconnect.replaceDescription"
          : "appstoreconnect.addDescription",
      )}
      busy={busy}
      layout="compact"
      onClose={onClose}
      footer={
        <ButtonRow align="end">
          <Button disabled={busy} onClick={onClose} size="sm" variant="ghost">
            {t("common:actions.cancel")}
          </Button>
          <Button
            busy={busy}
            form="fdy-asc-key-form"
            size="sm"
            type="submit"
            variant="primary"
          >
            {t(
              busy
                ? "appstoreconnect.validating"
                : replacing
                  ? "appstoreconnect.replace"
                  : "appstoreconnect.validate",
            )}
          </Button>
        </ButtonRow>
      }
    >
      <FormLayout as="form" id="fdy-asc-key-form" onSubmit={submit}>
        <Alert tone="info" title={t("appstoreconnect.teamKey")} />
        <FormField>
          <span>{t("appstoreconnect.issuerLabel")}</span>
          <TextInput
            aria-describedby={
              issues.issuer ? "fdy-asc-issuer-error" : "fdy-asc-issuer-help"
            }
            aria-invalid={issues.issuer ? true : undefined}
            autoComplete="off"
            placeholder={t("appstoreconnect.issuerPlaceholder")}
            tone="boxed"
            value={issuerId}
            onChange={(event) => setIssuerId(event.target.value)}
          />
          <FieldHint id="fdy-asc-issuer-help">
            {t("appstoreconnect.issuerHelp")}
          </FieldHint>
          {issues.issuer ? (
            <FieldHint id="fdy-asc-issuer-error" tone="error">
              {issues.issuer}
            </FieldHint>
          ) : null}
        </FormField>
        <FormField>
          <span>{t("appstoreconnect.keyIdLabel")}</span>
          <TextInput
            aria-describedby={
              issues.key ? "fdy-asc-key-error" : "fdy-asc-key-help"
            }
            aria-invalid={issues.key ? true : undefined}
            autoComplete="off"
            placeholder={t("appstoreconnect.keyIdPlaceholder")}
            tone="boxed"
            value={keyId}
            onChange={(event) => setKeyId(event.target.value)}
          />
          <FieldHint id="fdy-asc-key-help">
            {t("appstoreconnect.keyIdHelp")}
          </FieldHint>
          {issues.key ? (
            <FieldHint id="fdy-asc-key-error" tone="error">
              {issues.key}
            </FieldHint>
          ) : null}
        </FormField>
        <FormField>
          <span>{t("appstoreconnect.nameLabel")}</span>
          <TextInput
            autoComplete="off"
            placeholder={t("appstoreconnect.namePlaceholder")}
            tone="boxed"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </FormField>
        <div className="grid min-w-0 gap-2">
          <span className="text-xs font-semibold text-ink">
            {t("appstoreconnect.privateKeyLabel")}
          </span>
          <SegmentedControl
            aria-label={t("appstoreconnect.sourceLabel")}
            options={[
              { label: t("appstoreconnect.uploadFile"), value: "file" },
              { label: t("appstoreconnect.pasteText"), value: "paste" },
            ]}
            size="sm"
            value={source}
            onValueChange={(value) => {
              setSource(value);
              setPrivateKey("");
              setFileError("");
              setIssues((current) => ({ ...current, privateKey: undefined }));
              if (fileInput.current) fileInput.current.value = "";
            }}
          />
          {source === "file" ? (
            <FormFieldGroup>
              <FileInput
                accept=".p8,application/x-pem-file"
                aria-invalid={issues.privateKey ? true : undefined}
                ref={fileInput}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  setFileError("");
                  setPrivateKey("");
                  setFileName(file?.name ?? "");
                  if (!file) return;
                  if (file.size > 16 * 1024) {
                    setFileError(t("appstoreconnect.errors.fileTooLarge"));
                    return;
                  }
                  void file.text().then(
                    (text) => {
                      setPrivateKey(text);
                      setIssues((current) => ({
                        ...current,
                        privateKey: undefined,
                      }));
                    },
                    () => setFileError(t("appstoreconnect.errors.fileRead")),
                  );
                }}
                className="fdy-xacc-file block w-full text-xs"
              />
              {fileName ? (
                <FieldHint>
                  <FileKey2 aria-hidden="true" size={13} />
                  {fileName}
                </FieldHint>
              ) : null}
              {fileError ? (
                <FieldHint tone="error">{fileError}</FieldHint>
              ) : null}
            </FormFieldGroup>
          ) : (
            <Textarea
              aria-invalid={issues.privateKey ? true : undefined}
              aria-label={t("appstoreconnect.privateKeyLabel")}
              placeholder={t("appstoreconnect.privateKeyPlaceholder")}
              resize="vertical"
              rows={7}
              spellCheck={false}
              tone="boxed"
              value={privateKey}
              onChange={(event) => {
                setPrivateKey(event.target.value);
                setIssues((current) => ({
                  ...current,
                  privateKey: undefined,
                }));
              }}
            />
          )}
          <FieldHint>
            {t(
              discarded
                ? "appstoreconnect.keyDiscarded"
                : "appstoreconnect.privateKeyHelp",
            )}
          </FieldHint>
          {issues.privateKey ? (
            <FieldHint tone="error">{issues.privateKey}</FieldHint>
          ) : null}
        </div>
        {error ? (
          <Alert
            actions={
              <Button size="sm" onClick={() => setError("")}>
                {t("appstoreconnect.editAndRetry")}
              </Button>
            }
            title={t("appstoreconnect.validationFailed")}
            tone="error"
          >
            {error}
          </Alert>
        ) : null}
      </FormLayout>
    </Dialog>
  );
}
