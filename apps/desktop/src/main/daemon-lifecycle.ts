export function connectCliEnvironment(
  packaged: boolean,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (!packaged) return environment;
  const sanitized = { ...environment };
  delete sanitized.MDBASE_CONNECT_HOME;
  delete sanitized.MDBASE_CONNECT_SOCKET;
  return sanitized;
}

export function daemonCliArguments(
  packaged: boolean,
  stateDirectory: string,
  endpoint: string,
  command: string[],
  json = false
): string[] {
  return [
    ...(packaged ? [] : ["--state-dir", stateDirectory, "--endpoint", endpoint]),
    ...(json ? ["--json"] : []),
    "connect",
    "daemon",
    ...command
  ];
}
