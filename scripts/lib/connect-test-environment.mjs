// Compatibility facade for consumer repositories. The lifecycle implementation
// is shared with the interactive development environment.
export {
  availablePort,
  sanitizeProjectName,
  startConnectTestEnvironment,
  waitForReady
} from "./connect-environment.mjs";
