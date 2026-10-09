import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getAuthState, logout, onAuthRequired, updateMyLocale } from "../api";
import type { AccountUser, AuthState } from "../api-types";
import { AuthScreen } from "../features/accounts";
import { clearConversationStorage } from "../components/conversation/conversation-storage";
import { storedThemeMode } from "./navigation";
import { useTranslation } from "react-i18next";
import {
  applyLocalePreference,
  storedLocalePreference,
  type LocalePreference,
} from "../i18n";

export interface AccountSession {
  /** Undefined only while the server is unreachable. */
  user?: AccountUser;
  replaceUser: (user: AccountUser) => void;
  signOut: () => Promise<void>;
}

const unavailableSession: AccountSession = {
  replaceUser: () => undefined,
  signOut: async () => undefined,
};

const AccountSessionContext = createContext<AccountSession>(unavailableSession);

export function useAccountSession(): AccountSession {
  return useContext(AccountSessionContext);
}

const invitePathPattern = /^\/invite\/([^/]+)\/?$/;

export function inviteTokenFromPath(pathname: string): string | undefined {
  const token = invitePathPattern.exec(pathname)?.[1];
  if (!token) return undefined;
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

type GateState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; auth: AuthState };

/**
 * Decides between the app and a sign-in screen. When the auth endpoint is
 * unreachable the app still renders so its own "API not reachable" state and
 * demo fallback keep working.
 */
export function AccountsGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ status: "loading" });
  const [inviteToken, setInviteToken] = useState(() =>
    inviteTokenFromPath(window.location.pathname),
  );

  const refresh = useCallback(async () => {
    try {
      setState({ status: "ready", auth: await getAuthState() });
    } catch {
      setState({ status: "unavailable" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAuthRequired(() => void refresh());
  }, [refresh]);

  const leaveInvitePath = useCallback(() => {
    if (!inviteToken) return;
    window.history.replaceState(null, "", "/");
    setInviteToken(undefined);
  }, [inviteToken]);

  const auth = state.status === "ready" ? state.auth : undefined;
  const session = useMemo<AccountSession>(
    () =>
      auth
        ? {
            user: auth.user,
            replaceUser: (user) =>
              setState({ status: "ready", auth: { ...auth, user } }),
            signOut: async () => {
              await logout();
              // Unsent drafts and queued messages may hold sensitive text.
              clearConversationStorage();
              setState({ status: "ready", auth: { ...auth, user: undefined } });
            },
          }
        : unavailableSession,
    [auth],
  );

  const signedOut = auth !== undefined && !auth.user;
  const locale = auth?.user?.locale;
  const signedIn = Boolean(auth?.user);
  useEffect(() => {
    // Signed out, this browser's choice applies. Signed in, the account's
    // choice wins; an account without one adopts the choice made on the
    // sign-in screen, so it follows the person to their other devices.
    if (!signedIn) {
      void applyLocalePreference(undefined);
      return;
    }
    const chosenHere = storedLocalePreference();
    if (!locale && chosenHere) {
      void updateMyLocale(chosenHere)
        .then((user) =>
          setState((current) =>
            current.status === "ready"
              ? { status: "ready", auth: { ...current.auth, user } }
              : current,
          ),
        )
        .catch(() => applyLocalePreference(undefined));
      return;
    }
    void applyLocalePreference((locale ?? "") as LocalePreference);
  }, [signedIn, locale]);
  // A language change renders the app afresh, so copy from plain helpers
  // (labels, relative times) follows it everywhere, memoized parts included.
  const { i18n: translations } = useTranslation();
  useEffect(() => {
    // A signed-in visitor opening an invite link lands in the app instead.
    if (state.status !== "loading" && !signedOut) leaveInvitePath();
  }, [state.status, signedOut, leaveInvitePath]);

  if (state.status === "loading") return null;

  if (signedOut) {
    const kind = auth?.needsSetup ? "setup" : inviteToken ? "invite" : "login";
    return (
      <AuthScreen
        inviteToken={inviteToken}
        key={kind}
        kind={kind}
        onAuthenticated={(next) => {
          leaveInvitePath();
          setState({ status: "ready", auth: { ...next, needsSetup: false } });
        }}
        theme={storedThemeMode()}
      />
    );
  }

  return (
    <AccountSessionContext.Provider value={session}>
      <Fragment key={translations.language}>{children}</Fragment>
    </AccountSessionContext.Provider>
  );
}
