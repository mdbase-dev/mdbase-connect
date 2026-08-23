import type { JSX } from "react";

export type VisibleEnvironment = "lab" | "staging" | "local";

const visibleEnvironments = new Set<VisibleEnvironment>(["lab", "staging", "local"]);

export function visibleEnvironment(value: string | undefined): VisibleEnvironment | null {
  const normalized = value?.trim().toLowerCase() as VisibleEnvironment | undefined;
  return normalized && visibleEnvironments.has(normalized) ? normalized : null;
}

export function EnvironmentBadge(): JSX.Element | null {
  const environment = visibleEnvironment(import.meta.env.VITE_MDBASE_ENV);
  if (!environment) return null;
  return (
    <div
      className={`environment-badge is-${environment}`}
      role="status"
      aria-label={`${environment} environment`}
    >
      {environment}
    </div>
  );
}
