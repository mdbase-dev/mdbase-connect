import { resolveFeedbackEndpoint } from "@mdbase-dev/ui/feedback";

// Deployment configuration only. UI, schema, screenshots, and diagnostics live in @mdbase-dev/ui.
export function feedbackEndpoint(): string | null {
  return resolveFeedbackEndpoint(import.meta.env.VITE_MDBASE_FEEDBACK_URL, import.meta.env.DEV);
}
export function turnstileSiteKey(): string | null {
  return import.meta.env.VITE_MDBASE_TURNSTILE_SITE_KEY?.trim() || null;
}
