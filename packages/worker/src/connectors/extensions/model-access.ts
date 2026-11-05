import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  ConnectorDescriptor,
  ExtensionModelProfile,
} from "@bd777/foundry-protocol";
import {
  connectorModelProviders,
  saveConnectorModelProviders,
  type ConnectorModelProvider,
} from "../../harness/connector-model-providers.js";
import type { ExtensionHost } from "./host.js";
import { extensionDataDir, loadedExtensions } from "./registry.js";

/**
 * Model access from connector extensions (docs/connector-extensions.md,
 * "模型接入"): a connector that provides it lists the model providers its
 * login gives this device; each becomes a device profile whose sessions
 * start the extension's session helper per native process
 * (foundry.connection.v1, harness/external-connection.ts). The list lives
 * in harness/connector-model-providers.ts, where the profiles read it.
 */

const profileIdPattern = /^[a-z0-9]+(_[a-z0-9]+)*$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const listTimeoutMs = 60_000;

/**
 * A listed provider, checked. One the extension says is not usable now keeps
 * the connection last verified for it (so its identity, check result and
 * chats stay the same) and carries the reason.
 */
function checkedProvider(
  value: ExtensionModelProfile,
  connector: ConnectorDescriptor,
  extensionId: string,
  extensionDir: string,
  previous: ConnectorModelProvider[],
): ConnectorModelProvider | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!profileIdPattern.test(value.id ?? "") || value.id.length > 64)
    return undefined;
  if (value.runtime !== "claude") return undefined;
  if (
    typeof value.label !== "string" ||
    !value.label.trim() ||
    value.label.length > 80
  )
    return undefined;
  const models = Array.isArray(value.models)
    ? value.models
        .filter(
          (model) => typeof model === "string" && modelPattern.test(model),
        )
        .slice(0, 32)
    : [];
  const model = modelPattern.test(value.model ?? "") ? value.model : models[0];
  if (!model) return undefined;
  const connectorRef = {
    kind: connector.kind,
    label: connector.label,
    extensionId,
  };
  const problem =
    typeof value.problem === "string" && value.problem.trim()
      ? value.problem.trim().slice(0, 300)
      : undefined;
  if (problem) {
    const before = previous.find(
      (provider) =>
        provider.id === value.id &&
        provider.connector.extensionId === extensionId &&
        provider.connector.kind === connector.kind,
    );
    // Never verified here: listed, but it cannot start a session.
    const externalConnection = before?.externalConnection ?? {
      executable: "",
      args: [],
      identity: "",
    };
    return {
      id: value.id,
      label: value.label.trim(),
      runtime: "claude",
      model,
      models: models.includes(model) ? models : [model, ...models],
      externalConnection,
      connector: connectorRef,
      problem,
    };
  }
  if (
    typeof value.identity !== "string" ||
    !value.identity ||
    value.identity.length > 512
  )
    return undefined;
  const data = extensionDataDir(extensionId);
  const substitute = (text: string) =>
    text
      .replaceAll("${extensionDir}", extensionDir)
      .replaceAll("${dataDir}", data);
  const executable = substitute(value.session?.command ?? "");
  const args = (value.session?.args ?? []).map((arg) =>
    substitute(String(arg)),
  );
  if (
    !isAbsolute(executable) ||
    !existsSync(executable) ||
    args.length > 32 ||
    args.some((arg) => arg.length > 4096)
  )
    return undefined;
  return {
    id: value.id,
    label: value.label.trim(),
    runtime: "claude",
    model,
    models: models.includes(model) ? models : [model, ...models],
    // Key order is the check fingerprint's (harness/profiles.ts).
    externalConnection: { executable, args, identity: value.identity },
    connector: connectorRef,
  };
}

/** Whether a listed provider is not usable now, so it is asked again soon. */
export function modelAccessHasProblems(): boolean {
  return connectorModelProviders().some((provider) => provider.problem);
}

/**
 * Asks every installed model-access connector for its providers and keeps
 * the answer; a connector that does not answer keeps what it listed last.
 * A provider leaves only when its connector's answer no longer lists it: one
 * that is listed but not usable now stays, unavailable with the reason.
 * Returns whether the providers changed.
 */
export async function refreshExtensionModelProviders(
  host: ExtensionHost,
  log: (message: string) => void = console.warn,
): Promise<boolean> {
  const previous = connectorModelProviders();
  const next: ConnectorModelProvider[] = [];
  const ids = new Set<string>();
  for (const extension of loadedExtensions(log)) {
    for (const connector of extension.manifest.connectors) {
      if (!connector.provides?.modelAccess) continue;
      let listed: ConnectorModelProvider[];
      try {
        const result = await host.call(
          extension.manifest.id,
          "modelAccess.list",
          { kind: connector.kind },
          listTimeoutMs,
        );
        listed = (Array.isArray(result.profiles) ? result.profiles : [])
          .map((profile) =>
            checkedProvider(
              profile,
              connector,
              extension.manifest.id,
              extension.installed.dir,
              previous,
            ),
          )
          .filter((profile): profile is ConnectorModelProvider =>
            Boolean(profile),
          );
      } catch (error) {
        log(
          `model access from ${extension.manifest.id}/${connector.kind} not read: ${String(error)}`,
        );
        listed = previous.filter(
          (provider) =>
            provider.connector.extensionId === extension.manifest.id &&
            provider.connector.kind === connector.kind,
        );
      }
      for (const provider of listed) {
        if (ids.has(provider.id)) continue;
        ids.add(provider.id);
        next.push(provider);
      }
    }
  }
  return saveConnectorModelProviders(next);
}
