// A second hard boundary in addition to the disabled next-control-plane flag.
export interface LabFixtureConfig { adminToken: string }

export function validateLabFixtureConfig(config: LabFixtureConfig, environment: string | undefined, publicUrl: string): void {
  if (environment !== "lab" || publicUrl.replace(/\/$/, "") !== "https://connect-lab.mdbase.dev") {
    throw new Error("LAB fixtures require the fixed LAB environment and origin.");
  }
  if (Buffer.byteLength(config.adminToken, "utf8") < 32 || /[\r\n]/.test(config.adminToken)) {
    throw new Error("The separate LAB fixture admin credential must be at least 32 bytes.");
  }
}

export function parseLabFixtureConfig(env: NodeJS.ProcessEnv): LabFixtureConfig | undefined {
  const adminToken = env.MDBASE_NEXT_LAB_FIXTURE_ADMIN_TOKEN;
  if (!adminToken) return undefined;
  const config = { adminToken };
  validateLabFixtureConfig(config, env.MDBASE_CONNECT_ENVIRONMENT, env.PUBLIC_URL ?? "");
  if (env.MDBASE_NEXT_CONTROL_PLANE !== "1") throw new Error("LAB fixtures require the next control plane.");
  return config;
}
