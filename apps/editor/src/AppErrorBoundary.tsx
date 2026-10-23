import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { FeedbackButton, useFeedback } from "@mdbase-dev/ui/feedback";

interface AppErrorBoundaryProps {
  children: ReactNode;
  product?: "mdbase editor" | "mdbase connect";
}

interface AppErrorBoundaryState {
  error?: Error;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.product ?? "mdbase editor"} encountered an unrecoverable UI error`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <FatalError product={this.props.product ?? "mdbase editor"} />;
  }
}

function FatalError({ product }: { product: "mdbase editor" | "mdbase connect" }) {
  useLingui();
  const { reportError } = useFeedback();
  useEffect(() => { reportError({ code: "unknown_error" }); }, [reportError]);
  return <main className="fatal-error" role="alert"><div>
    <strong><Trans>{product} needs to restart</Trans></strong>
    <p><Trans>Your collection was not deleted. Changes that had already finished saving are safe.</Trans></p>
    <button onClick={() => location.reload()}>{product === "mdbase connect" ? t`Reload Connect` : t`Reload editor`}</button>
    <FeedbackButton topic="problem" />
  </div></main>;
}
