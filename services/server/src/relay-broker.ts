import {
  connect,
  RequestError,
  TimeoutError,
  type Msg,
  type NatsConnection,
  type Subscription
} from "@nats-io/transport-node";
import {
  isConnectProblem,
  type ConnectProblem
} from "@mdbase-dev/connect-protocol";

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

export type RelayBrokerError =
  | { kind: "connector"; problem: ConnectProblem }
  | { kind: "unavailable" | "internal"; code: string; message: string };

export type RelayBrokerReply = {
  version: 1;
  ok: true;
  value?: unknown;
} | {
  version: 1;
  ok: false;
  error: RelayBrokerError;
};

export type RelayBrokerBinaryReply = {
  version: 1;
  ok: true;
  value: Uint8Array;
} | {
  version: 1;
  ok: false;
  error: RelayBrokerError;
};

export interface RelayBrokerBinding {
  close(): Promise<void>;
}

export interface RelayBroker {
  bind(input: {
    connectorId: string;
    generation: string;
    handle(command: RelayBrokerCommand): Promise<RelayBrokerReply>;
    handleBinary(frame: Uint8Array): Promise<RelayBrokerBinaryReply>;
    replaced(): void;
  }): Promise<RelayBrokerBinding>;
  request(
    connectorId: string,
    generation: string,
    command: RelayBrokerCommand,
    timeoutMs: number
  ): Promise<RelayBrokerReply>;
  requestBinary(
    connectorId: string,
    generation: string,
    frame: Uint8Array,
    timeoutMs: number
  ): Promise<RelayBrokerBinaryReply>;
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
  handleBinary(frame: Uint8Array): Promise<RelayBrokerBinaryReply>;
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

  async requestBinary(
    connectorId: string,
    generation: string,
    frame: Uint8Array,
    _timeoutMs: number
  ): Promise<RelayBrokerBinaryReply> {
    this.assertOpen();
    const binding = this.bindings.get(deliverySubject(connectorId, generation));
    if (!binding) throw new RelayBrokerUnavailableError("No relay owns the current connector session.");
    return binding.handleBinary(frame);
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
      user: "mdbase-connect",
      pass: `mdbase_${config.token}`,
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
    handleBinary(frame: Uint8Array): Promise<RelayBrokerBinaryReply>;
    replaced(): void;
  }): Promise<RelayBrokerBinding> {
    this.assertAvailable();
    assertSubjectParts(input.connectorId, input.generation);
    const delivery = this.connection.subscribe(deliverySubject(input.connectorId, input.generation), {
      callback: (error, message) => {
        void this.handleRequest(error, message, input.handle);
      }
    });
    const binaryDelivery = this.connection.subscribe(
      binaryDeliverySubject(input.connectorId, input.generation),
      {
        callback: (error, message) => {
          void this.handleBinaryRequest(error, message, input.handleBinary);
        }
      }
    );
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
    return new NatsRelayBinding(delivery, binaryDelivery, replacements);
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

  async requestBinary(
    connectorId: string,
    generation: string,
    frame: Uint8Array,
    timeoutMs: number
  ): Promise<RelayBrokerBinaryReply> {
    this.assertAvailable();
    assertSubjectParts(connectorId, generation);
    try {
      const response = await this.connection.request(
        binaryDeliverySubject(connectorId, generation),
        frame,
        { timeout: timeoutMs }
      );
      return decodeBinaryReply(response.data);
    } catch (error) {
      if (error instanceof RelayBrokerUnavailableError) throw error;
      if (error instanceof TimeoutError
          || (error instanceof RequestError && error.isNoResponders())) {
        throw new RelayBrokerUnavailableError("No relay owns the current connector session.", {
          cause: error
        });
      }
      throw new RelayBrokerUnavailableError("The relay broker file request failed.", {
        cause: error
      });
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

  private async handleBinaryRequest(
    error: Error | null,
    message: Msg,
    handle: (frame: Uint8Array) => Promise<RelayBrokerBinaryReply>
  ): Promise<void> {
    if (error || !message.reply) return;
    let reply: RelayBrokerBinaryReply;
    try {
      reply = await handle(message.data);
    } catch {
      reply = binaryInternalError("relay_file_delivery_failed", "The relay could not deliver the file frame.");
    }
    this.connection.publish(message.reply, encodeBinaryReply(reply));
  }
}

class NatsRelayBinding implements RelayBrokerBinding {
  private closed = false;

  constructor(
    private readonly delivery: Subscription,
    private readonly binaryDelivery: Subscription,
    private readonly replacements: Subscription
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.delivery.unsubscribe();
    this.binaryDelivery.unsubscribe();
    this.replacements.unsubscribe();
  }
}

export async function createRelayBroker(config: RelayBrokerConfig | null): Promise<RelayBroker> {
  return config ? NatsRelayBroker.connect(config) : new LocalRelayBroker();
}

function deliverySubject(connectorId: string, generation: string): string {
  return `${SUBJECT_PREFIX}.deliver.${connectorId}.${generation}`;
}

function binaryDeliverySubject(connectorId: string, generation: string): string {
  return `${SUBJECT_PREFIX}.file.${connectorId}.${generation}`;
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

function encodeBinaryReply(reply: RelayBrokerBinaryReply): Uint8Array {
  if (!reply.ok) {
    const error = encodeJson(reply);
    const output = new Uint8Array(error.byteLength + 1);
    output[0] = 0;
    output.set(error, 1);
    return output;
  }
  const output = new Uint8Array(reply.value.byteLength + 1);
  output[0] = 1;
  output.set(reply.value, 1);
  return output;
}

function decodeBinaryReply(data: Uint8Array): RelayBrokerBinaryReply {
  if (data.byteLength < 2) {
    throw new RelayBrokerUnavailableError("The relay broker returned an invalid file response.");
  }
  if (data[0] === 1) return { version: 1, ok: true, value: data.slice(1) };
  if (data[0] === 0) {
    const reply = decodeJson(data.subarray(1));
    if (isRelayBrokerReply(reply) && !reply.ok) return reply;
  }
  throw new RelayBrokerUnavailableError("The relay broker returned an invalid file response.");
}

function isRelayBrokerCommand(value: unknown): value is RelayBrokerCommand {
  if (!isObject(value) || value.version !== 1) return false;
  return (value.kind === "deliver" || value.kind === "policy") && "message" in value;
}

function isRelayBrokerReply(value: unknown): value is RelayBrokerReply {
  if (!isObject(value) || value.version !== 1 || typeof value.ok !== "boolean") return false;
  if (value.ok) return true;
  if (!isObject(value.error)) return false;
  if (value.error.kind === "connector") return isConnectProblem(value.error.problem);
  return (value.error.kind === "unavailable" || value.error.kind === "internal")
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

function binaryInternalError(code: string, message: string): RelayBrokerBinaryReply {
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
