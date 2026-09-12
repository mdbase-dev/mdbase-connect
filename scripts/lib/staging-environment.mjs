import { managedEnvironments } from "./managed-environments.mjs";

export const stagingEnvironment = Object.freeze({
  ...managedEnvironments.staging,
  loopbackPort: 28_486,
  loopbackOrigin: "http://127.0.0.1:28486"
});
