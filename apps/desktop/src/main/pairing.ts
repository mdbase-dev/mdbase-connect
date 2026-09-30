const REQUEST_TIMEOUT_MS = 10_000;

type Connector = { id: string; name: string };
type Outcome = { status: "pending" | "paired"; connector?: Connector };
type Pending = {
  serverUrl: string;
  secret: string;
  verificationUri: string;
  expiresAt: number;
  token?: string;
  connector?: Connector;
  exchange?: Promise<Outcome>;
};

/** Pairing secrets stay in the main process; retries continue one exact request. */
export class ComputerPairing {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly actions: {
    openBrowser(url: string): Promise<unknown>;
    configure(serverUrl: string, token: string): Promise<unknown>;
    completed(): void;
  }) {}

  async begin(serverUrl: string, connectorName: string) {
    for (const [id, request] of this.pending) {
      if (!request.token && !request.exchange && Date.now() >= request.expiresAt) this.pending.delete(id);
    }
    const response = await fetch(`${serverUrl}/v1/pairing-requests`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ connector_name: connectorName }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const body = await response.json() as {
      pairing_id?: string; pairing_secret?: string; verification_uri?: string;
      expires_in?: number; error?: { message?: string };
    };
    if (!response.ok || !body.pairing_id || !body.pairing_secret || !body.verification_uri
      || !body.pairing_secret.startsWith("pair_") || body.pairing_secret.length < 24
      || /\s/.test(body.pairing_secret) || !body.expires_in || body.expires_in < 0 || body.expires_in > 86_400) {
      throw new Error(body.error?.message ?? `Pairing failed with HTTP ${response.status}.`);
    }
    const verification = new URL(body.verification_uri);
    if (verification.origin !== new URL(serverUrl).origin || verification.username || verification.password) {
      throw new Error("The pairing server returned an untrusted verification address.");
    }
    this.pending.set(body.pairing_id, {
      serverUrl, secret: body.pairing_secret, verificationUri: body.verification_uri,
      expiresAt: Date.now() + body.expires_in * 1_000
    });
    return { pairingId: body.pairing_id, verificationUri: body.verification_uri, expiresIn: body.expires_in };
  }

  async reopen(id: string): Promise<void> {
    const request = this.request(id);
    if (Date.now() >= request.expiresAt) throw new Error("That pairing request expired. Start again.");
    await this.actions.openBrowser(request.verificationUri);
  }

  async status(id: string): Promise<Outcome> {
    const request = this.request(id);
    if (request.exchange) return request.exchange;
    request.exchange = this.exchange(id, request);
    try { return await request.exchange; }
    finally { request.exchange = undefined; }
  }

  private request(id: string): Pending {
    const request = this.pending.get(id);
    if (!request) throw new Error("That pairing request is no longer active.");
    return request;
  }

  private async exchange(id: string, request: Pending): Promise<Outcome> {
    // Retain an exchanged token until local configuration is acknowledged.
    if (!request.token) {
      if (Date.now() >= request.expiresAt) throw new Error("That pairing request expired. Start again.");
      const response = await fetch(`${request.serverUrl}/v1/pairing-requests/${id}/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${request.secret}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const body = await response.json() as {
        status?: "pending" | "paired"; token?: string; connector?: Connector; error?: { message?: string };
      };
      if (response.status === 202) return { status: "pending" };
      if (!response.ok || body.status !== "paired" || !body.token) {
        throw new Error(body.error?.message ?? `Pairing failed with HTTP ${response.status}.`);
      }
      request.token = body.token;
      request.connector = body.connector;
    }
    await this.actions.configure(request.serverUrl, request.token);
    this.pending.delete(id);
    this.actions.completed();
    return { status: "paired", connector: request.connector };
  }
}
