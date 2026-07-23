import {
  connect,
  RequestError,
  TimeoutError,
  type Msg,
  type NatsConnection,
  type Subscription
} from "@nats-io/transport-node";

const SUBJECT_PREFIX = "mdbase.connect.relay.v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RelayBrokerConfig {
  servers: string[];
  token: string;
}

export interface RelayBrokerCommand {
  version: 1;
  kind: "deliver" | "policy";
  message: unknown;
}

export type RelayBrokerReply = {
  version: 1;
  ok: true;
  value?: unknown;
} | {
  version: 1;
  ok: false;
  error: {
    kind: "unavailable" | "connector" | "internal";
    code: string;
    message: string;
  };
};

export interface RelayBrokerBinding {
  close(): Promise<void>;
}

export interface RelayBroker {
  bind(input: {
    connectorId: string;
    generation: string;
    handle(command: RelayBrokerCommand): Promise<RelayBrokerReply>;
    replaced(): void;
  }): Promise<RelayBrokerBinding>;
  request(
    connectorId: string,
    generation: string,
    command: RelayBrokerCommand,
    timeoutMs: number
  ): Promise<RelayBrokerReply>;
  publishReplacement(connectorId: string, generation: string): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export class RelayBrokerUnavailableError extends Error {
  constructor(message = "The relay broker is unavailable.", options?: ErrorOptions) {
    super(message, options);
  }
}

interface LocalBinding {
  connectorId: string;
  generation: string;
  handle(command: RelayBrokerCommand): Promise<RelayBrokerReply>;
  replaced(): void;
}

/**
 * The zero-dependency broker for single-process and embedded deployments.
 * NATS is an optional transport, not a requirement for self-hosting Connect.
 */
export class LocalRelayBroker implements RelayBroker {
  private readonly bindings = new Map<string, LocalBinding>();
  private closed = false;

  async bind(input: LocalBinding): Promise<RelayBrokerBinding> {
    this.assertOpen();
    const key = deliverySubject(input.connectorId, input.generation);
    const previous = this.bindings.get(key);
    if (previous) previous.replaced();
    this.bindings.set(key, input);
    return {
      close: async () => {
        if (this.bindings.get(key) === input) this.bindings.delete(key);
      }
    };
  }

  async request(
    connectorId: string,
    generation: string,
    command: RelayBrokerCommand,
    _timeoutMs: number
  ): Promise<RelayBrokerReply> {
    this.assertOpen();
    const binding = this.bindings.get(deliverySubject(connectorId, generation));
    if (!binding) throw new RelayBrokerUnavailableError("No relay owns the current connector session.");
    return binding.handle(command);
  }

  async publishReplacement(connectorId: string, generation: string): Promise<void> {
    this.assertOpen();
    for (const binding of this.bindings.values()) {
      if (binding.connectorId === connectorId && compareGeneration(generation, binding.generation) > 0) {
        binding.replaced();
      }
    }
  }

  async ready(): Promise<void> {
    this.assertOpen();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.bindings.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new RelayBrokerUnavailableError("The relay broker is closed.");
  }
}

export class NatsRelayBroker implements RelayBroker {
  private available = true;

  private constructor(private readonly connection: NatsConnection) {
    void this.monitorConnection();
  }

  static async connect(config: RelayBrokerConfig): Promise<NatsRelayBroker> {
    const connection = await connect({
      servers: config.servers,
      token: config.token,
      name: `mdbase-connect-${process.pid}`,
      waitOnFirstConnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 500
    });
    return new NatsRelayBroker(connection);
  }

  async bind(input: {
    connectorId: string;
    generation: string;
    handle(command: RelayBrokerCommand): Promise<RelayBrokerReply>;
    replaced(): void;
  }): Promise<RelayBrokerBinding> {
    this.assertAvailable();
    assertSubjectParts(input.connectorId, input.generation);
    const delivery = this.connection.subscribe(deliverySubject(input.connectorId, input.generation), {
      callback: (error, message) => {
        void this.handleRequest(error, message, input.handle);
      }
    });
    const replacements = this.connection.subscribe(replacementSubject(input.connectorId), {
      callback: (error, message) => {
        if (error) return;
        const replacement = decodeJson(message.data);
        if (isReplacement(replacement)
            && compareGeneration(replacement.generation, input.generation) > 0) {
          input.replaced();
        }
      }
    });
    await this.connection.flush();
    return new NatsRelayBinding(delivery, replacements);
  }

  async request(
    connectorId: string,
    generation: string,
    command: RelayBrokerCommand,
    timeoutMs: number
  ): Promise<RelayBrokerReply> {
    this.assertAvailable();
    assertSubjectParts(connectorId, generation);
    try {
      const response = await this.connection.request(
        deliverySubject(connectorId, generation),
        encodeJson(command),
        { timeout: timeoutMs }
      );
      const reply = decodeJson(response.data);
      if (!isRelayBrokerReply(reply)) {
        throw new RelayBrokerUnavailableError("The relay broker returned an invalid response.");
      }
      return reply;
    } catch (error) {
      if (error instanceof RelayBrokerUnavailableError) throw error;
      if (error instanceof TimeoutError
          || (error instanceof RequestError && error.isNoResponders())) {
        throw new RelayBrokerUnavailableError("No relay owns the current connector session.", {
          cause: error
        });
      }
      throw new RelayBrokerUnavailableError("The relay broker request failed.", { cause: error });
    }
  }

  async publishReplacement(connectorId: string, generation: string): Promise<void> {
    this.assertAvailable();
    assertSubjectParts(connectorId, generation);
    this.connection.publish(replacementSubject(connectorId), encodeJson({ version: 1, generation }));
    await this.connection.flush();
  }

  async ready(): Promise<void> {
    this.assertAvailable();
    await withTimeout(this.connection.flush(), 1_000);
  }

  async close(): Promise<void> {
    this.available = false;
    if (!this.connection.isClosed()) await this.connection.drain();
  }

  private assertAvailable(): void {
    if (!this.available || this.connection.isClosed()) {
      throw new RelayBrokerUnavailableError("The relay broker is disconnected.");
    }
  }

  private async monitorConnection(): Promise<void> {
    for await (const status of this.connection.status()) {
      if (status.type === "reconnect") this.available = true;
      if (status.type === "disconnect"
          || status.type === "reconnecting"
          || status.type === "staleConnection"
          || status.type === "forceReconnect"
          || status.type === "close") {
        this.available = false;
      }
    }
  }

  private async handleRequest(
    error: Error | null,
    message: Msg,
    handle: (command: RelayBrokerCommand) => Promise<RelayBrokerReply>
  ): Promise<void> {
    if (error || !message.reply) return;
    const decoded = decodeJson(message.data);
    let reply: RelayBrokerReply;
    if (!isRelayBrokerCommand(decoded)) {
      reply = internalError("invalid_broker_command", "The relay command was invalid.");
    } else {
      try {
        reply = await handle(decoded);
      } catch {
        reply = internalError("relay_delivery_failed", "The relay could not deliver the request.");
      }
    }
    this.connection.publish(message.reply, encodeJson(reply));
  }
}

class NatsRelayBinding implements RelayBrokerBinding {
  private closed = false;

  constructor(
    private readonly delivery: Subscription,
    private readonly replacements: Subscription
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.delivery.unsubscribe();
    this.replacements.unsubscribe();
  }
}

export async function createRelayBroker(config: RelayBrokerConfig | null): Promise<RelayBroker> {
  return config ? NatsRelayBroker.connect(config) : new LocalRelayBroker();
}

function deliverySubject(connectorId: string, generation: string): string {
  return `${SUBJECT_PREFIX}.deliver.${connectorId}.${generation}`;
}

function replacementSubject(connectorId: string): string {
  return `${SUBJECT_PREFIX}.replace.${connectorId}`;
}

function assertSubjectParts(connectorId: string, generation: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectorId)
      || !/^[0-9]+$/.test(generation)) {
    throw new RelayBrokerUnavailableError("Invalid relay routing metadata.");
  }
}

function compareGeneration(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decodeJson(data: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(data));
  } catch {
    return null;
  }
}

function isRelayBrokerCommand(value: unknown): value is RelayBrokerCommand {
  if (!isObject(value) || value.version !== 1) return false;
  return (value.kind === "deliver" || value.kind === "policy") && "message" in value;
}

function isRelayBrokerReply(value: unknown): value is RelayBrokerReply {
  if (!isObject(value) || value.version !== 1 || typeof value.ok !== "boolean") return false;
  if (value.ok) return true;
  return isObject(value.error)
    && (value.error.kind === "unavailable"
      || value.error.kind === "connector"
      || value.error.kind === "internal")
    && typeof value.error.code === "string"
    && typeof value.error.message === "string";
}

function isReplacement(value: unknown): value is { version: 1; generation: string } {
  return isObject(value)
    && value.version === 1
    && typeof value.generation === "string"
    && /^[0-9]+$/.test(value.generation);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function internalError(code: string, message: string): RelayBrokerReply {
  return { version: 1, ok: false, error: { kind: "internal", code, message } };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RelayBrokerUnavailableError()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
