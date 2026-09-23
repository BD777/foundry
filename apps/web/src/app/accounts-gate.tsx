import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getAuthState, logout, onAuthRequired } from "../api";
import type { AccountUser, AuthState } from "../api-types";
import { AuthScreen } from "../features/accounts";
import { storedThemeMode } from "./navigation";

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
              setState({ status: "ready", auth: { ...auth, user: undefined } });
            },
          }
        : unavailableSession,
    [auth],
  );

  const signedOut = auth !== undefined && !auth.user;
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
      {children}
    </AccountSessionContext.Provider>
  );
}
