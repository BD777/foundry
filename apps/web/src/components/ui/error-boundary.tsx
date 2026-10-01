import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  errorBoundaryMessage,
  requiresPageReload,
  shouldResetErrorBoundary,
} from "../../lib/error-boundary-policy";
import { Button } from "./button";
import { EmptyState } from "./empty-state";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Label of the scope that failed, such as a view name. */
  label: string;
  onError?: (message: string) => void;
  /** Changing this value clears a caught failure automatically. */
  resetKey?: string;
  retryLabel?: string;
}

interface ErrorBoundaryState {
  message: string;
}

/**
 * Contains a render failure so the rest of the control plane keeps working. The
 * fallback is announced to assistive technology and offers an explicit retry.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { message: "" };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: errorBoundaryMessage(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // i18n-ignore: console log, never shown
    console.error("Foundry view failed to render", error, info.componentStack);
    this.props.onError?.(errorBoundaryMessage(error));
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (
      shouldResetErrorBoundary({
        failed: this.state.message !== "",
        nextResetKey: this.props.resetKey ?? "",
        previousResetKey: previous.resetKey ?? "",
      })
    ) {
      this.setState({ message: "" });
    }
  }

  private readonly retry = (): void => {
    if (requiresPageReload(this.state.message)) {
      window.location.reload();
      return;
    }
    this.setState({ message: "" });
  };

  override render(): ReactNode {
    if (!this.state.message) {
      return this.props.children;
    }
    return (
      <ErrorFallback
        label={this.props.label}
        message={this.state.message}
        onRetry={this.retry}
        retryLabel={this.props.retryLabel}
      />
    );
  }
}

function ErrorFallback({
  label,
  message,
  onRetry,
  retryLabel,
}: {
  label: string;
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}) {
  const { t } = useTranslation("ui");
  return (
    <EmptyState
      aria-live="assertive"
      body={
        <>
          {message} {t("errorBoundary.stillAvailable")}{" "}
          <Button onClick={onRetry} size="sm" variant="secondary">
            {requiresPageReload(message)
              ? t("errorBoundary.reload")
              : (retryLabel ?? t("errorBoundary.tryAgain"))}
          </Button>
        </>
      }
      role="alert"
      title={t("errorBoundary.title", { label })}
    />
  );
}
