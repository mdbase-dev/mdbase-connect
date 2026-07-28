export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailDelivery {
  provider: string;
  messageId: string;
}

export interface EmailTransport {
  send(
    message: TransactionalEmail,
    idempotencyKey: string
  ): Promise<EmailDelivery>;
}

export interface ResendEmailTransportOptions {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
  endpoint?: string;
}

interface ResendSuccess {
  id?: unknown;
}

interface ResendErrorBody {
  name?: unknown;
}

export class EmailDeliveryError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number | null = null
  ) {
    super("Transactional email delivery failed.");
    this.name = "EmailDeliveryError";
  }
}

export class ResendEmailTransport implements EmailTransport {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetch: typeof fetch;
  private readonly endpoint: string;

  constructor(options: ResendEmailTransportOptions) {
    this.apiKey = options.apiKey.trim();
    this.from = options.from.trim();
    this.fetch = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? "https://api.resend.com/emails";
    if (!this.apiKey) throw new TypeError("Resend API key is required.");
    if (!this.from || /[\r\n]/u.test(this.from)) {
      throw new TypeError("Transactional email sender is invalid.");
    }
    const endpoint = new URL(this.endpoint);
    if (
      endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
      || (endpoint.protocol !== "https:" && !isLoopback(endpoint.hostname))
    ) {
      throw new TypeError("Resend email endpoint must use HTTPS.");
    }
  }

  async send(
    message: TransactionalEmail,
    idempotencyKey: string
  ): Promise<EmailDelivery> {
    validateMessage(message);
    validateIdempotencyKey(idempotencyKey);
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "user-agent": "mdbase-connect/transactional-email"
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html
        }),
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new EmailDeliveryError("network_error", true);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ResendErrorBody;
      const providerCode = typeof body.name === "string"
        && /^[a-z0-9_]{1,100}$/u.test(body.name)
        ? body.name
        : `http_${response.status}`;
      throw new EmailDeliveryError(
        providerCode,
        response.status === 408
          || response.status === 409
          || response.status === 429
          || response.status >= 500,
        response.status
      );
    }
    const body = await response.json().catch(() => ({})) as ResendSuccess;
    if (typeof body.id !== "string" || !body.id) {
      throw new EmailDeliveryError("invalid_provider_response", true, response.status);
    }
    return { provider: "resend", messageId: body.id };
  }
}

function validateMessage(message: TransactionalEmail): void {
  if (
    !message.to.trim()
    || /[\r\n]/u.test(message.to)
    || !message.subject.trim()
    || /[\r\n]/u.test(message.subject)
    || !message.text
    || !message.html
  ) {
    throw new TypeError("Transactional email message is invalid.");
  }
}

function validateIdempotencyKey(value: string): void {
  if (!value || value.length > 256 || /[^\x21-\x7e]/u.test(value)) {
    throw new TypeError("Email idempotency key is invalid.");
  }
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}
