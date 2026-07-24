import { lookup } from "node:dns";
import { Agent } from "node:https";
import { BlockList, type LookupFunction } from "node:net";
import webPush from "web-push";
import {
  PushDeliveryError,
  type PushSubscriptionTarget,
  type PushTransport
} from "./notifications.js";

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

const blockedPushAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedPushAddresses.addSubnet(network, prefix, "ipv4");
}
blockedPushAddresses.addAddress("::", "ipv6");
blockedPushAddresses.addAddress("::1", "ipv6");
blockedPushAddresses.addSubnet("fc00::", 7, "ipv6");
blockedPushAddresses.addSubnet("fe80::", 10, "ipv6");
blockedPushAddresses.addSubnet("ff00::", 8, "ipv6");
blockedPushAddresses.addSubnet("2001:db8::", 32, "ipv6");

export class WebPushTransport implements PushTransport {
  private readonly agent = new Agent({
    keepAlive: true,
    lookup: publicPushLookup
  });

  constructor(private readonly config: VapidConfig) {
    // Validate the pair at startup without mutating web-push's global defaults.
    webPush.getVapidHeaders(
      "https://push.example",
      config.subject,
      config.publicKey,
      config.privateKey,
      "aes128gcm"
    );
  }

  async send(target: PushSubscriptionTarget, payload: string): Promise<void> {
    try {
      await webPush.sendNotification(target, payload, {
        TTL: 60 * 60 * 24,
        urgency: "normal",
        timeout: 15_000,
        vapidDetails: this.config,
        agent: this.agent
      });
    } catch (error) {
      const statusCode = webPushStatus(error);
      throw new PushDeliveryError(
        error instanceof Error ? error.message : "Web Push delivery failed.",
        statusCode === 404 || statusCode === 410
      );
    }
  }
}

const publicPushLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, {
    all: true,
    family: options.family,
    hints: options.hints,
    order: "verbatim"
  }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const publicAddresses = addresses.filter(({ address, family }) =>
      isPublicPushAddress(address, family)
    );
    if (publicAddresses.length === 0) {
      callback(
        Object.assign(new Error("The Web Push endpoint resolved to a non-public address."), {
          code: "EACCES"
        }),
        []
      );
      return;
    }
    if (options.all) {
      callback(null, publicAddresses);
    } else {
      callback(null, publicAddresses[0].address, publicAddresses[0].family);
    }
  });
};

export function isPublicPushAddress(address: string, family: number): boolean {
  return !blockedPushAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function webPushStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = Reflect.get(error, "statusCode");
  return typeof statusCode === "number" ? statusCode : undefined;
}
