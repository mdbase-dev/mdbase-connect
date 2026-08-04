import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectInternals } from "./connect.js";
import type { MdbaseConnectOptions } from "./connect-options.js";
import {
  MdbaseConnection,
  type MdbaseAuthorizationOutcome,
  type MdbaseAuthorizationResult,
  type MdbaseAuthorizeOptions,
  type MdbaseConnectEnvironment
} from "./connection.js";
import type { MdbaseConnectionInfo } from "./connection-types.js";
import { defaultCallbackUrl } from "./runtime-utils.js";
import {
  AUTHORIZATION_PROBLEM_CODES,
  REGISTRATION_PROBLEM_CODES,
  captureConnectOutcome,
  type AuthorizationProblemCode,
  type ConnectOutcome,
  type RegistrationProblemCode
} from "./outcomes.js";
import { MdbaseApplicationSession, type MdbaseApplicationSessionOptions } from "./application-session.js";
import type { MdbaseUnavailableReason } from "./session.js";
import type { Application } from "./internal-types.js";
import type { ConnectRequestOptions } from "./operation-types.js";

export class MdbaseConnect<Frontmatter extends JsonObject = JsonObject> {
  private readonly internals: MdbaseConnectInternals<Frontmatter>;

  constructor(options: MdbaseConnectOptions) {
    this.internals = new MdbaseConnectInternals(options);
  }

  register(options?: ConnectRequestOptions): Promise<ConnectOutcome<Application, RegistrationProblemCode>> {
    return captureConnectOutcome(
      () => this.internals.register(options),
      REGISTRATION_PROBLEM_CODES
    );
  }

  authorize(
    options: MdbaseAuthorizeOptions = {}
  ): Promise<ConnectOutcome<MdbaseAuthorizationOutcome<Frontmatter>, AuthorizationProblemCode>> {
    return captureConnectOutcome(
      () => this.internals.authorize(options),
      AUTHORIZATION_PROBLEM_CODES
    );
  }

  /** The ordinary application lifecycle entry point. */
  application(
    options: MdbaseApplicationSessionOptions
  ): MdbaseApplicationSession<Frontmatter> {
    return new MdbaseApplicationSession(this, options, this.internals.timeouts);
  }

  manifest(options?: ConnectRequestOptions): Promise<ConnectOutcome<import("@mdbase-dev/connect-protocol").MdbaseAppManifest, RegistrationProblemCode>> {
    return captureConnectOutcome(
      () => this.internals.manifestDeclaration(options),
      REGISTRATION_PROBLEM_CODES
    );
  }

  environment(): MdbaseConnectEnvironment {
    return this.internals.environment();
  }

  completeAuthorization(
    callbackUrl?: string | URL,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseAuthorizationResult<Frontmatter>, AuthorizationProblemCode>> {
    return captureConnectOutcome(
      () => this.internals.completeAuthorization(
        callbackUrl === undefined ? defaultCallbackUrl() : String(callbackUrl),
        options
      ),
      AUTHORIZATION_PROBLEM_CODES
    );
  }

  connections(): MdbaseConnectionInfo[] {
    return this.internals.connections();
  }

  connection(collectionId: string): MdbaseConnection<Frontmatter> | null {
    return this.internals.connection(collectionId);
  }

  unavailableReason(collectionId: string): MdbaseUnavailableReason | null {
    return this.internals.unavailableReason(collectionId);
  }

  onConnectionsChange(listener: (connections: MdbaseConnectionInfo[]) => void): () => void {
    return this.internals.onConnectionsChange(listener);
  }

  forgetAll(): void {
    for (const connection of this.connections()) {
      this.connection(connection.collectionId)?.forget();
    }
  }

  /** Forget a public TOFU pin after independently verifying a replaced connector. */
  forgetConnectorIdentity(connectorId: string): void {
    this.internals.forgetConnectorIdentity(connectorId);
  }
}
