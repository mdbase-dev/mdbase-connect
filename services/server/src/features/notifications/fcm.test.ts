import { describe, expect, it, vi } from "vitest";
import { FcmTransport } from "./fcm.js";

const payload = JSON.stringify({
  type: "mdbase.notification",
  version: 1,
  signal_id: "signal_opaque",
  criterion_id: "task.changed",
  cursor: "42",
  presentation: {
    title: "Tasks changed",
    body: "Open Worklog to refresh.",
    tag: "task-change"
  }
});

describe("FCM transport", () => {
  it("sends a privacy-minimal cross-platform HTTP v1 message", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ name: "projects/tasks/messages/1" }),
      { status: 200 }
    ));
    const transport = new FcmTransport({
      auth: { getAccessToken: async () => "short-lived-access-token" },
      fetch: fetcher
    });

    await transport.send({
      projectId: "tasks-production",
      token: "device-token"
    }, payload);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(
      "https://fcm.googleapis.com/v1/projects/tasks-production/messages:send"
    );
    expect(init.headers.authorization).toBe("Bearer short-lived-access-token");
    const body = JSON.parse(init.body);
    expect(body.message).toMatchObject({
      token: "device-token",
      notification: {
        title: "Tasks changed",
        body: "Open Worklog to refresh."
      },
      data: {
        type: "mdbase.notification",
        version: "1",
        signal_id: "signal_opaque",
        criterion_id: "task.changed",
        cursor: "42"
      },
      android: {
        notification: {
          channel_id: "mdbase-updates",
          tag: "task-change"
        }
      },
      apns: {
        payload: {
          aps: { "thread-id": "task-change" }
        }
      }
    });
    expect(init.body).not.toContain("path");
    expect(init.body).not.toContain("frontmatter");
  });

  it("marks unregistered installation targets as permanent", async () => {
    const transport = new FcmTransport({
      auth: { getAccessToken: async () => "token" },
      fetch: async () => new Response(JSON.stringify({
        error: {
          status: "NOT_FOUND",
          details: [{
            "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
            errorCode: "UNREGISTERED"
          }]
        }
      }), { status: 404 })
    });

    await expect(transport.send({
      projectId: "tasks-production",
      token: "expired-token"
    }, payload)).rejects.toMatchObject({ permanent: true });
  });

  it("retains retryable provider failures and Retry-After", async () => {
    const transport = new FcmTransport({
      auth: { getAccessToken: async () => "token" },
      fetch: async () => new Response("busy", {
        status: 503,
        headers: { "retry-after": "9" }
      })
    });

    await expect(transport.send({
      projectId: "tasks-production",
      token: "active-token"
    }, payload)).rejects.toMatchObject({
      permanent: false,
      retryAfterMs: 9_000
    });
  });
});
