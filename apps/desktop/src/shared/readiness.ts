export interface AgentReadiness {
  schema_version: number;
  ready: boolean;
  binary_version: string;
  safe_reason?: string;
}

export function presentReadiness(health: AgentReadiness | undefined, expectedVersion?: string): {
  state: "starting" | "ready" | "attention";
  reason?: string;
  label: string;
} {
  if (!health || health.schema_version !== 1 || typeof health.ready !== "boolean" ||
      typeof health.binary_version !== "string" ||
      (expectedVersion !== undefined && health.binary_version !== expectedVersion)) {
    return { state: "attention", reason: "incompatible_version", label: "Update or restart the local connector" };
  }
  if (health.ready === true && !health.safe_reason) {
    return { state: "ready", label: "Local connector ready" };
  }
  const labels: Record<string, string> = {
    starting: "Local connector starting",
    initialization_failed: "Local connector initialization failed; restart the connector",
    critical_worker_failed: "Local connector worker stopped; restart the connector",
    credential_store_unavailable: "Unlock the credential store, then restart the connector"
  };
  return {
    state: health.safe_reason === "starting" ? "starting" : "attention",
    reason: health.safe_reason ?? "invalid_readiness",
    label: labels[health.safe_reason ?? ""] ?? "Local connector needs attention"
  };
}
