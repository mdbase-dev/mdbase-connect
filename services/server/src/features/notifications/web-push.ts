import { Agent } from "node:https";
import webPush from "web-push";
import {
  PushDeliveryError,
  type PushSubscriptionTarget,
  type PushTransport
} from "./notifications.js";
import { isPublicNetworkAddress, publicHttpsLookup } from "./public-network.js";

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export class WebPushTransport implements PushTransport {
  private readonly agent = new Agent({
    keepAlive: true,
    lookup: publicHttpsLookup
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

export function isPublicPushAddress(address: string, family: number): boolean {
  return isPublicNetworkAddress(address, family);
}

function webPushStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = Reflect.get(error, "statusCode");
  return typeof statusCode === "number" ? statusCode : undefined;
}
