export type ConnectionDotState = "connected" | "connecting" | "paused" | "danger" | "idle";

export interface ConnectionStatus {
  state: "local_only" | "connecting" | "connected" | "offline";
  paused: boolean;
  relay_problem?: string;
}

export interface CloudConnection {
  configured: boolean;
}

export interface ConnectionPresentation {
  label: string;
  settingsLabel: string;
  dot: ConnectionDotState;
}

export function presentConnection(
  status: ConnectionStatus | null,
  cloud: CloudConnection | null
): ConnectionPresentation {
  if (cloud === null) {
    return { label: "Checking connection…", settingsLabel: "Checking", dot: "connecting" };
  }
  if (!cloud.configured) {
    return { label: "Local only", settingsLabel: "Local only", dot: "idle" };
  }
  if (status?.paused) {
    return { label: "Remote access paused", settingsLabel: "Paused", dot: "paused" };
  }
  if (status?.relay_problem) {
    return {
      label: status.relay_problem === "authentication_required"
        ? "Account connection needs authorization; reconnect this computer"
        : "Relay version incompatible; update the connector",
      settingsLabel: "Needs attention",
      dot: "danger"
    };
  }
  if (status === null || status.state === "connecting" || status.state === "local_only") {
    return { label: "Connecting securely…", settingsLabel: "Connecting", dot: "connecting" };
  }
  if (status.state === "connected") {
    return { label: "Connected securely", settingsLabel: "Connected", dot: "connected" };
  }
  return { label: "Connector offline", settingsLabel: "Offline", dot: "idle" };
}
