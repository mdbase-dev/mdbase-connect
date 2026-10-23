import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { observeProviderWidth } from "@mdbase/connect-ui/provider-button";
import React, { useEffect, useId, useRef, useState, useSyncExternalStore, type InputHTMLAttributes } from "react";
import { observeTheme, resolveDarkTheme } from "@mdbase-dev/ui/theme";
import { api, ApiError } from "./api";
import {
  isAuthorizationReturnTarget,
  message,
  returnTarget,
  signInUrl
} from "./portal-model";
import { PageBrand } from "./portal-ui";

function MinimalAuthPage({ children }: { children: React.ReactNode }) {
  useLocaleRevision();
  return <div className="minimal-auth-shell">
    <main className="center-page minimal-auth-page">
      <PageBrand label="connect" />
      {children}
    </main>
    <footer className="minimal-auth-footer">
      <a href="https://mdbase.dev/privacy/"><Trans>Privacy</Trans></a>
      <a href="https://mdbase.dev/terms/"><Trans>Terms</Trans></a>
    </footer>
  </div>;
}

/** Keep native constraints, but announce errors beside the field. */
function AuthInput({ label, matchValue, onChange, onBlur, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; matchValue?: string }) {
  useLocaleRevision();
  const labelId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.setCustomValidity(matchValue !== undefined && field.value && field.value !== matchValue ? t(i18n)({ message: "Passwords do not match.", context: "Account sign-in" }) : "");
    setError((current) => current ? field.validationMessage : "");
  }, [matchValue, props.value]);
  return <label>
    <span id={labelId}>{label}</span>
    <input {...props} className="mdbase-field" ref={input} name={props.name ?? props.autoComplete}
      aria-labelledby={labelId}
      aria-invalid={error ? true : undefined}
      aria-describedby={[props["aria-describedby"], error ? errorId : ""].filter(Boolean).join(" ") || undefined}
      onChange={(event) => { setError(""); onChange?.(event); }}
      onBlur={(event) => { setError(event.currentTarget.validationMessage); onBlur?.(event); }}
      onInvalid={(event) => {
        event.preventDefault();
        setError(event.currentTarget.validationMessage);
        if (event.currentTarget.form?.querySelector(":invalid") === event.currentTarget) event.currentTarget.focus();
      }}
    />
    {error && <span className="auth-field-error" id={errorId} role="alert">{error}</span>}
  </label>;
}

function Loading({ error }: { error: string }) {
  useLocaleRevision();
  return <MinimalAuthPage><section className="auth-panel" aria-busy={!error}>
    <h1>{error ? t(i18n)({ message: "Couldn’t connect", context: "Account sign-in" }) : t(i18n)({ message: "Opening mdbase connect", context: "Account sign-in" })}</h1>
    <p role={error ? "alert" : "status"}>{error || t(i18n)({ message: "Just a moment…", context: "Account sign-in" })}</p>
    {error && <button className="mdbase-button is-primary" onClick={() => location.reload()}><Trans>Try again</Trans></button>}
  </section></MinimalAuthPage>;
}

export function Login() {
  useLocaleRevision();
  const [name, setName] = useState("Callum");
  const [email, setEmail] = useState("callum@example.com");
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState(authenticationFlowError);
  const [busy, setBusy] = useState(false);
  const continuingAuthorization = isAuthorizationReturnTarget();

  useEffect(() => {
    async function identify() {
      try {
        await api("/v1/me");
        location.replace(returnTarget());
      } catch (identifyError) {
        if (!(identifyError instanceof ApiError) || identifyError.status !== 401) {
          setError(message(identifyError));
        }
        try {
          setConfig(await api<AuthConfig>("/v1/auth/config"));
          // Successful configuration supersedes a failed session lookup, but
          // an authentication return error still needs to be shown.
          setError(authenticationFlowError());
        } catch (configError) {
          setError(message(configError));
        }
      }
    }
    void identify();
  }, []);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/v1/dev/session", { method: "POST", body: JSON.stringify({ name, email }) });
      location.href = returnTarget();
    } catch (signInError) {
      setError(message(signInError));
      setBusy(false);
    }
  }

  if (!config) return <Loading error={error} />;
  if (config.provider === "tailscale") return (
    <MinimalAuthPage>
      <section className="auth-panel">
        <h1><Trans>Open this through Tailscale</Trans></h1>
        <p><Trans>Connect this device to your tailnet, then reload the page.</Trans></p>
        {error && <div className="message error" role="alert">{error}</div>}
        <button className="mdbase-button is-primary" onClick={() => location.reload()}><Trans>Try again</Trans></button>
      </section>
    </MinimalAuthPage>
  );
  const providers = config.providers.length > 0
    ? config.providers
    : config.provider === "github"
      ? [{ id: "github" as const, label: t(i18n)({ message: "Continue with GitHub", context: "Account sign-in" }), login_url: "/auth/github" }]
      : [];
  if (providers.length > 0 || config.password_login) return (
    <MinimalAuthPage>
      <section className="auth-panel">
        <h1>{continuingAuthorization ? t(i18n)({ message: "Sign in to continue", context: "Account sign-in" }) : t(i18n)({ message: "Sign in", context: "Account sign-in" })}</h1>
        <p>{continuingAuthorization
          ? t(i18n)({ message: "Sign in, review the request, and return to the application." })
          : config.registration === "open"
            ? t(i18n)({ message: "Your collections and account, in one place." })
            : t(i18n)({ message: "Sign in with the method connected to your invited account." })}</p>
        {error && <div className="message error" role="alert">{error}</div>}
        {config.password_login && (
          <PasswordLoginForm
            recoveryAvailable={config.password_recovery === true}
            onError={setError}
            onSignedIn={() => { location.href = returnTarget(); }}
          />
        )}
        <AuthProviders providers={providers} divider={config.password_login === true} onError={setError} />
        {config.registration !== "open" && (
          <p className="auth-footnote">
            {config.password_registration ? t(i18n)({ message: "Invited? Open the link in your invitation email. " }) : ""}
            <a href="https://mdbase.dev/beta/"><Trans>Join the signup waitlist</Trans></a>.
          </p>
        )}
        {config.registration === "open" && (config.password_public_registration || config.external_public_registration) && (
          <p className="auth-footnote"><Trans>
            New to mdbase? <a href={`/signup?return_to=${encodeURIComponent(returnTarget())}`}>Create an account</a>
          </Trans></p>
        )}
      </section>
    </MinimalAuthPage>
  );

  return (
    <MinimalAuthPage>
      <form className="auth-panel" aria-busy={busy} onSubmit={(event) => void signIn(event)}>
        <h1><Trans>Open your account</Trans></h1>
        <p><Trans>Development authentication is enabled.</Trans></p>
        {error && <div className="message error" role="alert">{error}</div>}
        <AuthInput label={t(i18n)({ message: "Name", context: "Account sign-in" })} autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} />
        <AuthInput label={t(i18n)({ message: "Email", context: "Account sign-in" })} type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        <button className="mdbase-button is-primary" type="submit" disabled={busy}><Trans>Continue</Trans></button>
      </form>
    </MinimalAuthPage>
  );
}

function PasswordLoginForm({
  recoveryAvailable,
  onError,
  onSignedIn
}: {
  recoveryAvailable: boolean;
  onError(value: string): void;
  onSignedIn(): void;
}) {
  useLocaleRevision();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await api("/v1/auth/password/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      onSignedIn();
    } catch (reason) {
      onError(message(reason));
      setBusy(false);
    }
  }

  return (
    <form className="password-auth-form" aria-busy={busy} onSubmit={(event) => void signIn(event)}>
      <AuthInput label={t(i18n)({ message: "Email", context: "Account sign-in" })}
        type="email"
        autoComplete="username"
        maxLength={320}
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <AuthInput label={t(i18n)({ message: "Password", context: "Account sign-in" })}
        type="password"
        autoComplete="current-password"
        maxLength={1024}
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button className="mdbase-button is-primary" disabled={busy} type="submit">
        {busy ? t(i18n)({ message: "Signing in…", context: "Account sign-in" }) : t(i18n)({ message: "Sign in", context: "Account sign-in" })}
      </button>
      {recoveryAvailable && (
        <a className="quiet-auth-link" href="/forgot-password"><Trans>
          Forgot your password?
        </Trans></a>
      )}
    </form>
  );
}

export function ForgotPassword() {
  useLocaleRevision();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<AuthConfig>("/v1/auth/config")
      .then(setConfig)
      .catch((reason) => setError(message(reason)));
  }, []);

  async function requestReset(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/v1/auth/password/recovery", {
        method: "POST",
        body: JSON.stringify({ email })
      });
      setSubmitted(true);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!config) return <Loading error={error} />;
  const available = config.password_recovery === true;
  return (
    <MinimalAuthPage>
      <section className="auth-panel">
        <h1>{submitted ? t(i18n)({ message: "Check your email", context: "Account sign-in" }) : t(i18n)({ message: "Reset your password", context: "Account sign-in" })}</h1>
        <p role={submitted ? "status" : undefined} aria-live={submitted ? "polite" : undefined}>{submitted
          ? t(i18n)({ message: "If an mdbase connect account uses that address, its one-time reset link is on the way." })
          : available
            ? t(i18n)({ message: "We’ll email you a reset link. It expires in one hour." })
            : t(i18n)({ message: "Password recovery is temporarily unavailable. You can still return to sign in." })}</p>
        {error && <div className="message error" role="alert">{error}</div>}
        {!submitted && available && (
          <form className="password-auth-form" aria-busy={busy} onSubmit={(event) => void requestReset(event)}>
            <AuthInput label={t(i18n)({ message: "Email", context: "Account sign-in" })}
              type="email"
              autoComplete="email"
              autoFocus
              maxLength={320}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button className="mdbase-button is-primary" disabled={busy} type="submit">
              {busy ? t(i18n)({ message: "Sending link…", context: "Account sign-in" }) : t(i18n)({ message: "Send reset link", context: "Account sign-in" })}
            </button>
          </form>
        )}
        <a className="quiet-auth-link" href="/login"><Trans>Return to sign in</Trans></a>
      </section>
    </MinimalAuthPage>
  );
}

// A mail scanner may open this link, so only the explicit button unsubscribes.
export function Unsubscribe({ unsubscribeToken }: { unsubscribeToken: string }) {
  useLocaleRevision();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unsubscribed, setUnsubscribed] = useState<"announcements" | "product_updates" | null>(null);

  async function unsubscribe(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ unsubscribed: "announcements" | "product_updates" }>(
        `/v1/email/unsubscribe?${new URLSearchParams({ token: unsubscribeToken })}`,
        { method: "POST" }
      );
      setUnsubscribed(result.unsubscribed);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  const topic = unsubscribed === "product_updates" ? t(i18n)({ message: "product updates", context: "Account sign-in" }) : "announcements";
  return (
    <MinimalAuthPage>
      <section className="auth-panel">
        <h1>{unsubscribed ? t(i18n)({ message: "You’re unsubscribed", context: "Account sign-in" }) : unsubscribeToken ? t(i18n)({ message: "Unsubscribe from mdbase email" }) : t(i18n)({ message: "This unsubscribe link can’t be opened" })}</h1>
        <p role={unsubscribed ? "status" : undefined} aria-live={unsubscribed ? "polite" : undefined}>
          {unsubscribed
            ? t(i18n)`You won’t receive ${topic} from mdbase Connect. Messages about your account, such as verification and security email, are still sent.`
            : unsubscribeToken
              ? t(i18n)({ message: "Stop receiving the kind of email this link came in. Messages about your account are still sent." })
              : t(i18n)({ message: "Open the link from the email again, or change email preferences in your account settings." })}
        </p>
        {error && <div className="message error" role="alert">{error}</div>}
        {unsubscribeToken && !unsubscribed && (
          <form className="password-auth-form" aria-busy={busy} onSubmit={(event) => void unsubscribe(event)}>
            <button className="mdbase-button is-primary" disabled={busy} type="submit">
              {busy ? t(i18n)({ message: "Unsubscribing…", context: "Account sign-in" }) : t(i18n)({ message: "Unsubscribe", context: "Account sign-in" })}
            </button>
          </form>
        )}
        <a className="quiet-auth-link" href="/account"><Trans>Manage email preferences</Trans></a>
      </section>
    </MinimalAuthPage>
  );
}

export function ResetPassword({ resetToken }: { resetToken: string }) {
  useLocaleRevision();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    void api<AuthConfig>("/v1/auth/config")
      .then(setConfig)
      .catch((reason) => setError(message(reason)));
  }, []);

  async function resetPassword(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/v1/auth/password/reset", {
        method: "POST",
        body: JSON.stringify({
          reset_token: resetToken,
          password
        })
      });
      setCompleted(true);
    } catch (reason) {
      setError(message(reason));
      setBusy(false);
    }
  }

  if (!config) return <Loading error={error} />;
  const ready = Boolean(resetToken && config.password_login);
  return (
    <MinimalAuthPage>
      <section className="auth-panel">
        <h1>{completed
          ? t(i18n)({ message: "Password changed", context: "Account sign-in" })
          : ready
            ? t(i18n)({ message: "Choose a new password", context: "Account sign-in" })
            : t(i18n)({ message: "This reset link can’t be opened" })}</h1>
        <p role={completed ? "status" : undefined} aria-live={completed ? "polite" : undefined}>{completed
          ? t(i18n)({ message: "Your other browser sessions have been signed out. This browser is now signed in with the new password." })
          : ready
            ? t(i18n)({ message: "Replacing your password signs out every other browser session connected to the account." })
            : resetToken
              ? t(i18n)({ message: "The link is invalid, expired, already used, or password sign-in is temporarily unavailable." })
              : t(i18n)({ message: "Open the complete password reset link from your email." })}</p>
        {error && <div className="message error" role="alert">{error}</div>}
        {!completed && ready && (
          <form className="password-auth-form" aria-busy={busy} onSubmit={(event) => void resetPassword(event)}>
            <AuthInput label={t(i18n)({ message: "New password", context: "Account sign-in" })}
              type="password"
              autoComplete="new-password"
              autoFocus
              minLength={15}
              maxLength={1024}
              aria-describedby="reset-password-guidance"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="field-note" id="reset-password-guidance"><Trans>
              Use at least 15 characters. Spaces are welcome.
            </Trans></p>
            <AuthInput label={t(i18n)({ message: "Confirm new password", context: "Account sign-in" })} matchValue={password} name="password-confirmation"
              type="password"
              autoComplete="new-password"
              minLength={15}
              maxLength={1024}
              required
              value={passwordConfirmation}
              onChange={(event) => setPasswordConfirmation(event.target.value)}
            />
            <button className="mdbase-button is-primary" disabled={busy} type="submit">
              {busy ? t(i18n)({ message: "Changing password…", context: "Account sign-in" }) : t(i18n)({ message: "Change password", context: "Account sign-in" })}
            </button>
          </form>
        )}
        {completed
          ? <a className="mdbase-button is-primary" href="/"><Trans>Open your account</Trans></a>
          : <a className="quiet-auth-link" href="/login"><Trans>Return to sign in</Trans></a>}
      </section>
    </MinimalAuthPage>
  );
}

export function Signup({
  invitationToken,
  verificationToken
}: {
  invitationToken: string;
  verificationToken: string;
}) {
  useLocaleRevision();
  const externalSignup = !invitationToken && !verificationToken
    && new URLSearchParams(location.search).get("external") === "1";
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [externalProofId, setExternalProofId] = useState("");
  const [email, setEmail] = useState("");
  const [requestSubmitted, setRequestSubmitted] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [agreementsAccepted, setAgreementsAccepted] = useState(false);
  const [productUpdates, setProductUpdates] = useState(false);
  const [error, setError] = useState(authenticationFlowError);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const prepared = useRef(false);

  useEffect(() => {
    if (prepared.current) return;
    prepared.current = true;
    async function prepare() {
      try {
        const authentication = await api<AuthConfig>("/v1/auth/config");
        setConfig(authentication);
        if (!authentication.agreements) return;
        if (invitationToken && authentication.password_invitation_registration) {
          const result = await api<{ invitation: InvitationPreview }>(
            "/v1/auth/password/invitation",
            {
              method: "POST",
              body: JSON.stringify({ invitation_token: invitationToken })
            }
          );
          setVerifiedEmail(result.invitation.email);
        } else if (
          verificationToken
          && authentication.password_public_registration
        ) {
          const result = await api<{ verification: VerificationPreview }>(
            "/v1/auth/password/signup/verification",
            {
              method: "POST",
              body: JSON.stringify({ verification_token: verificationToken })
            }
          );
          setVerifiedEmail(result.verification.email);
        } else if (externalSignup && authentication.external_public_registration) {
          const result = await api<{ proof_id: string; email: string; name: string }>(
            "/v1/auth/external/signup/preview", { method: "POST", body: "{}" }
          );
          setVerifiedEmail(result.email);
          setName(result.name);
          setExternalProofId(result.proof_id);
        }
      } catch (reason) {
        setError(message(reason));
      } finally {
        setLoading(false);
      }
    }
    void prepare();
  }, [invitationToken, verificationToken, externalSignup]);

  async function requestVerification(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/v1/auth/password/signup/request", {
        method: "POST",
        body: JSON.stringify({ email, return_to: returnTarget() })
      });
      setRequestSubmitted(true);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!config?.agreements || !verifiedEmail || !agreementsAccepted) return;
    setBusy(true);
    setError("");
    try {
      const publicSignup = Boolean(verificationToken && !invitationToken);
      const result = await api<{
        redirect_to?: string;
        onboarding?: { starter_collection?: "pending" } | null;
      }>(externalSignup
        ? "/v1/auth/external/signup"
        : publicSignup ? "/v1/auth/password/signup/public" : "/v1/auth/password/signup", {
        method: "POST",
        body: JSON.stringify({
          ...(!externalSignup ? {
            ...(publicSignup
              ? { verification_token: verificationToken }
              : { invitation_token: invitationToken }),
            password
          } : { proof_id: externalProofId }),
          name,
          terms_version: config.agreements.terms.version,
          privacy_version: config.agreements.privacy.version,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(externalSignup || publicSignup ? { product_updates: productUpdates } : {})
        })
      });
      location.href = result.redirect_to ?? (result.onboarding?.starter_collection === "pending"
        && !isAuthorizationReturnTarget()
        ? "/getting-started"
        : returnTarget());
    } catch (reason) {
      setError(message(reason));
      setBusy(false);
    }
  }

  if (loading || !config) return <Loading error={error} />;
  const isInvitation = Boolean(invitationToken);
  const hasVerification = Boolean(verificationToken);
  const ready = Boolean(verifiedEmail && config.agreements);
  const canRequest = Boolean(
    !isInvitation
    && !hasVerification
    && !externalSignup
    && (config.password_public_registration || config.external_public_registration)
  );
  if (canRequest) return (
    <MinimalAuthPage>
      <section className="auth-panel">
        <h1>{requestSubmitted ? t(i18n)({ message: "Check your email", context: "Account sign-in" }) : t(i18n)({ message: "Create an account", context: "Account sign-in" })}</h1>
        <p role={requestSubmitted ? "status" : undefined} aria-live={requestSubmitted ? "polite" : undefined}>
          {requestSubmitted
            ? t(i18n)({ message: "If that address can be used, its one-time verification link is on the way." })
            : config.external_public_registration
              ? config.password_public_registration ? t(i18n)({ message: "Use a connected account, or verify your email to get started." }) : t(i18n)({ message: "Use a connected account to get started." })
              : t(i18n)({ message: "We’ll email you a link to verify your address. Then you can choose a password." })}
        </p>
        {error && <div className="message error" role="alert">{error}</div>}
        {!requestSubmitted && config.password_public_registration && (
          <form className="password-auth-form" aria-busy={busy} onSubmit={(event) => void requestVerification(event)}>
            <AuthInput label={t(i18n)({ message: "Email", context: "Account sign-in" })}
              type="email"
              autoComplete="email"
              autoFocus
              maxLength={320}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button className="mdbase-button is-primary" disabled={busy} type="submit">
              {busy ? t(i18n)({ message: "Sending link…", context: "Account sign-in" }) : t(i18n)({ message: "Send verification link", context: "Account sign-in" })}
            </button>
          </form>
        )}
        {!requestSubmitted && config.external_public_registration && (
          <AuthProviders providers={config.providers} divider={config.password_public_registration === true} onError={setError} />
        )}
        <p className="auth-footnote"><Trans>Already have an account? <a href={signInUrl()}>Sign in</a></Trans></p>
      </section>
    </MinimalAuthPage>
  );
  return (
    <MinimalAuthPage>
      <section className="auth-panel">
        <h1>{ready ? t(i18n)({ message: "Create an account", context: "Account sign-in" }) : t(i18n)({ message: "This account setup link can’t be opened" })}</h1>
        <p>{ready
          ? externalSignup
            ? t(i18n)({ message: "Your email is verified. Confirm your name to finish setting up your account. No password needed." })
            : t(i18n)({ message: "Your email is verified. Choose a name and password to finish setting up your account." })
          : isInvitation || hasVerification || externalSignup
            ? t(i18n)({ message: "The link is invalid, expired, already used, or account setup is temporarily unavailable." })
            : t(i18n)({ message: "Public account creation is temporarily unavailable." })}</p>
        {error && <div className="message error" role="alert">{error}</div>}
        {ready && config.agreements && (
          <form className="password-auth-form signup-form" aria-busy={busy} onSubmit={(event) => void createAccount(event)}>
            <AuthInput label={t(i18n)({ message: "Email", context: "Account sign-in" })}
              type="email"
              autoComplete="username"
              readOnly
              value={verifiedEmail}
            />
            <AuthInput label={t(i18n)({ message: "Name", context: "Account sign-in" })}
              autoComplete="name"
              maxLength={100}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {!externalSignup && <>
            <AuthInput label={t(i18n)({ message: "Password", context: "Account sign-in" })}
              type="password"
              autoComplete="new-password"
              minLength={15}
              maxLength={1024}
              aria-describedby="password-guidance"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="field-note" id="password-guidance"><Trans>
              Use at least 15 characters. Spaces are welcome.
            </Trans></p>
            <AuthInput label={t(i18n)({ message: "Confirm password", context: "Account sign-in" })} matchValue={password} name="password-confirmation"
              type="password"
              autoComplete="new-password"
              minLength={15}
              maxLength={1024}
              required
              value={passwordConfirmation}
              onChange={(event) => setPasswordConfirmation(event.target.value)}
            />
            </>}
            <label className="auth-agreement">
              <input
                type="checkbox"
                className="mdbase-checkbox"
                required
                checked={agreementsAccepted}
                onChange={(event) => setAgreementsAccepted(event.target.checked)}
              />
              <span><Trans>
                I agree to the{" "}
                <a href={config.agreements.terms.url} target="_blank" rel="noreferrer">
                  Terms of Service
                </a>{" "}
                and have read the{" "}
                <a href={config.agreements.privacy.url} target="_blank" rel="noreferrer">
                  Privacy Policy
                </a>.
              </Trans></span>
            </label>
            {!isInvitation && <label className="auth-agreement">
              <input
                type="checkbox"
                className="mdbase-checkbox"
                checked={productUpdates}
                onChange={(event) => setProductUpdates(event.target.checked)}
              />
              <span><Trans>Send me occasional product updates. You can change this at any time.</Trans></span>
            </label>}
            <button
              className="mdbase-button is-primary"
              disabled={busy || !agreementsAccepted}
              type="submit"
            >
              {busy ? t(i18n)({ message: "Creating account…", context: "Account sign-in" }) : t(i18n)({ message: "Create account", context: "Account sign-in" })}
            </button>
          </form>
        )}
        {externalSignup && (!ready || error) && <a className="quiet-auth-link" href={`/signup?return_to=${encodeURIComponent(returnTarget())}`}><Trans>Start signup again</Trans></a>}
        <a className="quiet-auth-link" href={signInUrl()}><Trans>Return to sign in</Trans></a>
      </section>
    </MinimalAuthPage>
  );
}

function authenticationFlowError(): string {
  switch (new URLSearchParams(location.search).get("auth_error")) {
    case "cancelled": return t(i18n)`Sign-in was cancelled. You can try again or choose another method.`;
    case "verified_email_required": return t(i18n)`A verified primary email is required. Verify your primary email with GitHub, or sign up using another method.`;
    default: return "";
  }
}

function AuthProviders({ providers, divider = false, onError }: {
  providers: AuthProviderOption[];
  divider?: boolean;
  onError(value: string): void;
}) {
  useLocaleRevision();
  if (!providers.length) return null;
  return <div className="auth-providers">
    {divider && <div className="provider-divider"><span><Trans>or</Trans></span></div>}
    {providers.map((provider) => <React.Fragment key={provider.id}>
      {provider.id === "google"
        ? <GoogleSignIn returnTo={returnTarget()} onError={onError} />
        : <a className="mdbase-button provider-button github-button" href={`${provider.login_url}?return_to=${encodeURIComponent(returnTarget())}`}>
            <GitHubMark />
            <span>{provider.label}</span>
          </a>}
    </React.Fragment>)}
  </div>;
}

interface AuthProviderOption {
  id: "google" | "github";
  label: string;
  login_url: string;
}

interface AuthConfig {
  provider: "google" | "github" | "tailscale" | "development" | "session";
  providers: AuthProviderOption[];
  registration: "closed" | "invite" | "open";
  development_login: boolean;
  password_login?: true;
  password_recovery?: true;
  password_registration?: true;
  password_invitation_registration?: true;
  password_public_registration?: true;
  external_public_registration?: true;
  agreements?: {
    terms: { version: string; url: string };
    privacy: { version: string; url: string };
  };
}

interface InvitationPreview {
  email: string;
  expires_at: string;
  terms_version: string;
  privacy_version: string;
}

interface VerificationPreview {
  email: string;
  expires_at: string;
}

interface GoogleAccountsApi {
  accounts: {
    id: {
      initialize(config: {
        client_id: string;
        nonce: string;
        auto_select: boolean;
        use_fedcm_for_button: boolean;
        callback(response: { credential: string }): void;
      }): void;
      renderButton(element: HTMLElement, config: {
        type: "standard";
        theme: "outline" | "filled_black";
        size: "large";
        text: "continue_with";
        locale?: string;
        shape: "rectangular";
        logo_alignment: "left";
        width: number;
      }): void;
    };
  };
}

let googleLibrary: Promise<GoogleAccountsApi> | null = null;

function GoogleSignIn({ returnTo, onError }: { returnTo: string; onError(value: string): void }) {
  useLocaleRevision();
  return <GoogleIdentityButton
    startUrl={`/auth/google?return_to=${encodeURIComponent(returnTo)}`}
    onComplete={navigateAfterAuthentication}
    onError={onError}
  />;
}

function navigateAfterAuthentication(redirectTo: string): void {
  location.href = redirectTo;
}

export function GoogleIdentityButton({ startUrl, onComplete, onError }: {
  startUrl: string;
  onComplete(redirectTo: string): void;
  onError(value: string): void;
}) {
  const localeRevision = useLocaleRevision();
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState<GoogleAccountsApi | null>(null);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const dark = useSyncExternalStore(observeTheme, () => resolveDarkTheme(), () => false);

  useEffect(() => {
    let active = true;
    async function prepare() {
      try {
        setGoogle(null);
        setFailed(false);
        const start = await api<{ client_id: string; nonce: string }>(startUrl);
        const loaded = await loadGoogleIdentityServices();
        if (!active) return;
        loaded.accounts.id.initialize({
          client_id: start.client_id,
          nonce: start.nonce,
          auto_select: false,
          use_fedcm_for_button: true,
          callback: (response) => {
            if (!active) return;
            setBusy(true);
            void api<{ redirect_to: string }>("/auth/google/callback", {
              method: "POST",
              headers: { "x-mdbase-auth": "google" },
              body: JSON.stringify({ credential: response.credential })
            }).then((result) => {
              onComplete(result.redirect_to);
            }).catch((reason) => {
              onError(message(reason));
              setGoogle(null);
              setBusy(false);
              setAttempt((value) => value + 1);
            });
          }
        });
        setGoogle(loaded);
      } catch (reason) {
        if (active) {
          setFailed(true);
          onError(message(reason));
        }
      }
    }
    void prepare();
    return () => { active = false; };
  }, [attempt, onComplete, onError, startUrl]);

  useEffect(() => observeProviderWidth(container.current, setWidth), []);

  // Google draws the button itself at a fixed pixel width, so the only way to
  // keep it aligned with the providers beside it is to ask for it again.
  useEffect(() => {
    if (!google || !width || !button.current) return;
    button.current.replaceChildren();
    google.accounts.id.renderButton(button.current, {
      type: "standard",
      theme: dark ? "filled_black" : "outline",
      size: "large",
      text: "continue_with",
      locale: i18n.locale === "pt" ? "pt-BR" : i18n.locale === "zh" ? "zh-CN" : i18n.locale,
      shape: "rectangular",
      logo_alignment: "left",
      width
    });
  }, [google, width, dark, localeRevision]);

  const ready = Boolean(google && width);
  return <div ref={container} className={`google-provider ${busy ? "busy" : ""}`} aria-busy={busy || (!ready && !failed)}>
    <div ref={button} className="google-button" inert={busy || !ready} aria-hidden={busy || !ready} />
    {!ready && <button type="button" className="mdbase-button provider-button provider-loading" disabled={!failed}
      onClick={() => { onError(""); setAttempt((value) => value + 1); }}>
      {!failed && <span className="auth-spinner" aria-hidden="true" />}
      {failed ? t(i18n)({ message: "Retry Google sign-in", context: "Account sign-in" }) : t(i18n)({ message: "Continue with Google", context: "Account sign-in" })}
    </button>}
    <span className="sr-only" role="status">{busy ? t(i18n)({ message: "Signing in with Google…", context: "Account sign-in" }) : !ready && !failed ? t(i18n)({ message: "Loading Google sign-in…", context: "Account sign-in" }) : ""}</span>
  </div>;
}

function GitHubMark() {
  useLocaleRevision();
  return (
    <svg
      className="github-mark"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function loadGoogleIdentityServices(): Promise<GoogleAccountsApi> {
  const current = (window as unknown as { google?: GoogleAccountsApi }).google;
  if (current?.accounts?.id) return Promise.resolve(current);
  if (googleLibrary) return googleLibrary;
  googleLibrary = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      const loaded = (window as unknown as { google?: GoogleAccountsApi }).google;
      if (loaded?.accounts?.id) resolve(loaded);
      else reject(new Error(t(i18n)({ message: "Google sign-in did not load correctly." })));
    };
    script.onerror = () => reject(new Error(t(i18n)({ message: "Google sign-in could not be loaded." })));
    document.head.append(script);
  });
  googleLibrary = googleLibrary.catch((reason) => {
    googleLibrary = null;
    throw reason;
  });
  return googleLibrary;
}
