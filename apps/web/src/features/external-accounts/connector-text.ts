import type {
  ConnectorDescriptor,
  ConnectorSignInMethod,
  ExternalAccessLevel,
  LocalizedText,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";

/**
 * A connector's own words in the page's language: a descriptor (built in
 * or from an extension) carries its names and sentences, so a connector
 * Foundry does not know still reads naturally.
 */
export function localized(text: string, texts?: LocalizedText): string {
  if (!texts) return text;
  const language = i18n.language;
  return texts[language] ?? texts[language.split("-")[0]!] ?? text;
}

/**
 * A workspace access level in the connector's own words (its access file on
 * the server): the label, what it allows and when to choose it, and which
 * provider permissions to allow when re-authorizing. A name the server's
 * levels do not list is shown as it is.
 */
export function accessLevelWords(
  levels: readonly ExternalAccessLevel[] | undefined,
  name: string | undefined,
): { label: string; description: string; grantHint: string } {
  const level = levels?.find((l) => l.name === name);
  return {
    label: level?.label ? localized(level.label, level.labels) : (name ?? ""),
    description: level?.description
      ? localized(level.description, level.descriptions)
      : "",
    grantHint: level?.grantHint
      ? localized(level.grantHint, level.grantHints)
      : "",
  };
}

/** The connector's name. */
export function connectorName(connector: ConnectorDescriptor): string {
  return localized(connector.label, connector.labels);
}

/** One sentence: what sessions can do with it, if it says. */
export function connectorDescription(
  connector: ConnectorDescriptor,
): string | undefined {
  return connector.description
    ? localized(connector.description, connector.descriptions)
    : undefined;
}

/** The ways to sign in Foundry offers on the page. */
export function signInMethods(
  connector: ConnectorDescriptor | undefined,
): ConnectorSignInMethod[] {
  return connector?.signIn?.methods ?? [];
}

/** Foundry can start a sign-in on the device (not only show commands). */
export function signsInHere(
  connector: ConnectorDescriptor | undefined,
): boolean {
  return signInMethods(connector).some((method) => method.kind === "guided");
}

/** The page offers signing in at all (guided, or the terminal's commands). */
export function offersSignIn(
  connector: ConnectorDescriptor | undefined,
): boolean {
  return signInMethods(connector).length > 0;
}

/** Foundry may sign the tool out on the device. */
export function signsOutHere(
  connector: ConnectorDescriptor | undefined,
): boolean {
  return signsInHere(connector) && connector?.signIn?.signOut !== false;
}
