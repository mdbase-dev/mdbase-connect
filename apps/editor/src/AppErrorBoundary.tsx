import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
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
    console.error("mdbase editor encountered an unrecoverable UI error", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <main className="fatal-error" role="alert">
      <div>
        <strong>mdbase editor needs to restart</strong>
        <p>Your collection was not deleted. Changes that had already finished saving are safe.</p>
        <button onClick={() => location.reload()}>Reload editor</button>
      </div>
    </main>;
  }
}
