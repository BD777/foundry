import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AccountsGate } from "./app/accounts-gate";
import { ErrorBoundary } from "./components/ui/error-boundary";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary label="Foundry" retryLabel="Reload Foundry">
      <AccountsGate>
        <App />
      </AccountsGate>
    </ErrorBoundary>
  </StrictMode>,
);
