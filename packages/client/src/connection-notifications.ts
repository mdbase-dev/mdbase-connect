import type { Application } from "./internal-types.js";
import type { StoredToken } from "./internal-types.js";
import { MdbaseConnectError } from "./errors.js";
import { apiError, parseStored } from "./runtime-utils.js";
import { base64UrlBytes, randomBase64Url } from "./base64.js";
import type {
  MdbaseNativeNotificationRegistration,
  MdbaseNativeNotificationRegistrationOptions,
  MdbaseNotificationRegistration,
  MdbaseNotificationRegistrationOptions
} from "./notifications.js";

export interface ConnectionNotificationContext {
  serverUrl: string;
  storage: Storage;
  authorizedToken(): Promise<StoredToken | null>;
  register(): Promise<Application>;
  notificationKey(transport?: "web_push" | "fcm"): string;
}

export class ConnectionNotifications {
  constructor(private readonly context: ConnectionNotificationContext) {}

  async registerNotifications(
    options: MdbaseNotificationRegistrationOptions
  ): Promise<MdbaseNotificationRegistration> {
    const token = await this.context.authorizedToken();
    if (!token) {
      throw new MdbaseConnectError(
        "not_authorized",
        "Connect this application before enabling notifications."
      );
    }
    const application = await this.context.register();
    const declared = application.notifications?.criteria.map((criterion) => criterion.id) ?? [];
    const criteria = [...new Set(options.criteria ?? declared)];
    const undeclared = criteria.find((criterion) => !declared.includes(criterion));
    if (undeclared) {
      throw new MdbaseConnectError(
        "notification_criterion_not_declared",
        `The application manifest does not declare notification criterion ${undeclared}.`
      );
    }
    if (criteria.length === 0) {
      throw new MdbaseConnectError(
        "notifications_not_declared",
        "This application manifest does not declare any notification criteria."
      );
    }
    const keyResponse = await fetch(`${this.context.serverUrl}/v1/notifications/vapid-public-key`);
    const keyBody = await keyResponse.json();
    if (!keyResponse.ok) {
      throw apiError(keyBody, "notifications_unavailable", "Push notifications are unavailable.", keyResponse.status);
    }
    let pushSubscription = await options.serviceWorker.pushManager.getSubscription();
    if (!pushSubscription) {
      pushSubscription = await options.serviceWorker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlBytes(keyBody.public_key)
      });
    }
    const serialized = pushSubscription.toJSON();
    if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
      throw new MdbaseConnectError(
        "invalid_push_subscription",
        "The browser returned an incomplete push subscription."
      );
    }
    const previous = parseStored<MdbaseNotificationRegistration>(
      this.context.storage.getItem(this.context.notificationKey())
    );
    const installationId = options.installationId
      ?? previous?.installationId
      ?? randomBase64Url(24);
    const channelResponse = await fetch(`${this.context.serverUrl}/v1/notifications/channels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        installation_id: installationId,
        criteria,
        subscription: {
          endpoint: serialized.endpoint,
          expirationTime: serialized.expirationTime ?? null,
          keys: serialized.keys
        }
      })
    });
    const channelBody = await channelResponse.json();
    if (!channelResponse.ok) {
      throw apiError(channelBody, "notification_registration_failed", "Could not register push notifications.", channelResponse.status);
    }
    if (previous?.channelId && previous.channelId !== channelBody.channel_id) {
      void fetch(`${this.context.serverUrl}/v1/notifications/channels/${previous.channelId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token.accessToken}` }
      }).catch(() => undefined);
    }
    const registration = {
      channelId: channelBody.channel_id,
      installationId,
      criteria
    };
    this.context.storage.setItem(this.context.notificationKey(), JSON.stringify(registration));
    return registration;
  }

  /**
   * Register an iOS or Android installation for Connect-managed FCM.
   *
   * The application manifest selects the Firebase project. Re-register the
   * same installation whenever Firebase refreshes its token.
   */
  async registerNativeNotifications(
    options: MdbaseNativeNotificationRegistrationOptions
  ): Promise<MdbaseNativeNotificationRegistration> {
    const token = await this.context.authorizedToken();
    if (!token) {
      throw new MdbaseConnectError(
        "not_authorized",
        "Connect this application before enabling notifications."
      );
    }
    const application = await this.context.register();
    if (application.notifications?.native_delivery?.mode !== "managed_fcm") {
      throw new MdbaseConnectError(
        "managed_fcm_not_declared",
        "This application does not declare Connect-managed native notifications."
      );
    }
    const declared = application.notifications.criteria.map(
      (criterion) => criterion.id
    );
    const criteria = [...new Set(options.criteria ?? declared)];
    const undeclared = criteria.find((criterion) => !declared.includes(criterion));
    if (undeclared) {
      throw new MdbaseConnectError(
        "notification_criterion_not_declared",
        `The application manifest does not declare notification criterion ${undeclared}.`
      );
    }
    if (criteria.length === 0) {
      throw new MdbaseConnectError(
        "notifications_not_declared",
        "This application manifest does not declare any notification criteria."
      );
    }
    const storageKey = this.context.notificationKey("fcm");
    const previous = parseStored<MdbaseNativeNotificationRegistration>(
      this.context.storage.getItem(storageKey)
    );
    const installationId = options.installationId
      ?? previous?.installationId
      ?? randomBase64Url(24);
    const response = await fetch(`${this.context.serverUrl}/v1/notifications/channels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        installation_id: installationId,
        criteria,
        transport: "fcm",
        token: options.token
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw apiError(
        body,
        "notification_registration_failed",
        "Could not register native notifications.",
        response.status
      );
    }
    if (previous?.channelId && previous.channelId !== body.channel_id) {
      void this.deleteNotificationChannel(previous.channelId, token.accessToken)
        .catch(() => undefined);
    }
    const registration: MdbaseNativeNotificationRegistration = {
      channelId: body.channel_id,
      installationId,
      transport: "fcm",
      criteria
    };
    this.context.storage.setItem(storageKey, JSON.stringify(registration));
    return registration;
  }

  async unregisterNativeNotifications(): Promise<void> {
    const storageKey = this.context.notificationKey("fcm");
    const registration = parseStored<MdbaseNativeNotificationRegistration>(
      this.context.storage.getItem(storageKey)
    );
    const token = await this.context.authorizedToken();
    if (registration?.channelId && !token) {
      throw new MdbaseConnectError(
        "not_authorized",
        "Reconnect this application before disabling native notifications."
      );
    }
    if (registration?.channelId && token) {
      await this.deleteNotificationChannel(
        registration.channelId,
        token.accessToken
      );
    }
    this.context.storage.removeItem(storageKey);
  }

  async unregisterNotifications(
    serviceWorker?: ServiceWorkerRegistration
  ): Promise<void> {
    const registration = parseStored<MdbaseNotificationRegistration>(
      this.context.storage.getItem(this.context.notificationKey())
    );
    const token = await this.context.authorizedToken();
    if (registration?.channelId && !token) {
      throw new MdbaseConnectError(
        "not_authorized",
        "Reconnect this application before disabling push notifications."
      );
    }
    if (registration?.channelId && token) {
      const response = await fetch(`${this.context.serverUrl}/v1/notifications/channels/${registration.channelId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token.accessToken}` }
      });
      if (!response.ok && response.status !== 404) {
        const body = await response.json();
        throw apiError(
          body,
          "notification_unregistration_failed",
          "Could not unregister push notifications.",
          response.status
        );
      }
    }
    this.context.storage.removeItem(this.context.notificationKey());
    const subscription = await serviceWorker?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  }
  private async deleteNotificationChannel(
    channelId: string,
    accessToken: string
  ): Promise<void> {
    const response = await fetch(
      `${this.context.serverUrl}/v1/notifications/channels/${channelId}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` }
      }
    );
    if (!response.ok && response.status !== 404) {
      const body = await response.json();
      throw apiError(
        body,
        "notification_unregistration_failed",
        "Could not unregister push notifications.",
        response.status
      );
    }
  }
}
