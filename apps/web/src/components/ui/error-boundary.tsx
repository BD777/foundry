import { Component, type ErrorInfo, type ReactNode } from "react";
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
      <EmptyState
        aria-live="assertive"
        body={
          <>
            {this.state.message} Other areas of Foundry are still available.{" "}
            <Button onClick={this.retry} size="sm" variant="secondary">
              {requiresPageReload(this.state.message)
                ? "Reload page"
                : (this.props.retryLabel ?? "Try again")}
            </Button>
          </>
        }
        role="alert"
        title={`${this.props.label} could not be displayed`}
      />
    );
  }
}
