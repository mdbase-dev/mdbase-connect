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

function relayProblemLabel(problem: string): string {
  switch (problem) {
    case "authentication_required":
      return "Account connection needs authorization; reconnect this computer";
    case "incompatible_version":
      return "Relay version incompatible; update the connector";
    case "policy_authority_mismatch":
      return "Computer registration changed; disconnect and reconnect this computer";
    case "policy_state_missing":
      return "Local authorization state is damaged; restore a verified backup";
    case "registration_restart_required":
      return "Computer registration changed; restart the connector";
    default:
      return "Account connection needs attention";
  }
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
  if (status?.relay_problem) {
    return {
      label: relayProblemLabel(status.relay_problem),
      settingsLabel: "Needs attention",
      dot: "danger"
    };
  }
  if (status?.paused) {
    return { label: "Remote access paused", settingsLabel: "Paused", dot: "paused" };
  }
  if (status === null || status.state === "connecting" || status.state === "local_only") {
    return { label: "Connecting securely…", settingsLabel: "Connecting", dot: "connecting" };
  }
  if (status.state === "connected") {
    return { label: "Connected securely", settingsLabel: "Connected", dot: "connected" };
  }
  return { label: "Connector offline", settingsLabel: "Offline", dot: "idle" };
}
