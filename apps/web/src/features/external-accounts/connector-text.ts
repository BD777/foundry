import type {
  ConnectorDescriptor,
  ConnectorSignInMethod,
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
