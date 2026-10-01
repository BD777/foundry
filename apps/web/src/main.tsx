import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { App } from "./App";
import { AccountsGate } from "./app/accounts-gate";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { i18n } from "./i18n";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <ErrorBoundary
        label="Foundry"
        retryLabel={i18n.t("shell:notices.reloadApp")}
      >
        <AccountsGate>
          <App />
        </AccountsGate>
      </ErrorBoundary>
    </I18nextProvider>
  </StrictMode>,
);
