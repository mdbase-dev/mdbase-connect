import React, { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import {
  invitationTokenFromFragment,
  isAuthorizationReturnTarget,
  message,
  returnTarget,
  tokenFromFragment
} from "./portal-model";
import { Loading, PageBrand } from "./portal-ui";

export function Login() {
  const [name, setName] = useState("Callum");
  const [email, setEmail] = useState("callum@example.com");
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState("");
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
        } catch (configError) {
          setError(message(configError));
        }
      }
    }
    void identify();
  }, []);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api("/v1/dev/session", { method: "POST", body: JSON.stringify({ name, email }) });
      location.href = returnTarget();
    } catch (signInError) {
      setError(message(signInError));
    }
  }

  if (!config) return <Loading error={error} />;
  if (config.provider === "tailscale") return (
    <main className="center-page">
      <PageBrand label="connect" />
      <section className="auth-panel">
        <p className="eyebrow">Tailnet identity</p>
        <h1>Open this through Tailscale.</h1>
        <p>mdbase connect signs you in from your tailnet identity. Make sure this device is connected to your tailnet, then reload this page.</p>
        {error && <div className="message error">{error}</div>}
        <button className="button primary" onClick={() => location.reload()}>Try again</button>
      </section>
    </main>
  );
  const providers = config.providers.length > 0
    ? config.providers
    : config.provider === "github"
      ? [{ id: "github" as const, label: "Continue with GitHub", login_url: "/auth/github" }]
      : [];
  if (providers.length > 0 || config.password_login) return (
    <main className="center-page">
      <PageBrand label="connect" />
      <section className="auth-panel">
        <p className="eyebrow">{continuingAuthorization ? "Choose a collection" : config.registration === "open" ? "Account access" : "Private preview"}</p>
        <h1>{continuingAuthorization ? "Sign in to continue" : "Sign in to mdbase connect"}</h1>
        <p>{continuingAuthorization
          ? `After you choose a collection and approve access, you’ll return to the app.${config.registration === "open" ? "" : " Sign-in is currently limited to invited accounts."}`
          : config.registration === "open"
            ? "Open your account with email or a connected identity provider."
            : "Access is currently limited to invited accounts. Sign in with the method attached to yours."}</p>
        {error && <div className="message error" role="alert">{error}</div>}
        {config.password_login && (
          <PasswordLoginForm
            recoveryAvailable={config.password_recovery === true}
            onError={setError}
            onSignedIn={() => { location.href = returnTarget(); }}
          />
        )}
        {providers.length > 0 && <div className="auth-providers">
          {config.password_login && providers.length > 0 && (
            <div className="provider-divider"><span>or</span></div>
          )}
          {providers.map((provider, index) => <React.Fragment key={provider.id}>
            {index > 0 && <div className="provider-divider"><span>or</span></div>}
            {provider.id === "google"
              ? <GoogleSignIn returnTo={returnTarget()} onError={setError} />
              : <a className="button primary link-button provider-button" href={`${provider.login_url}?return_to=${encodeURIComponent(returnTarget())}`}>
                  {provider.label}
                </a>}
          </React.Fragment>)}
        </div>}
        {config.password_registration && (
          <p className="auth-footnote">
            New here? Your invitation email contains the one-time account setup link.
          </p>
        )}
      </section>
    </main>
  );

  return (
    <main className="center-page">
      <PageBrand label="connect" />
      <form className="auth-panel" onSubmit={(event) => void signIn(event)}>
        <p className="eyebrow">Development session</p>
        <h1>Open your account</h1>
        <p>This temporary sign-in is available only when development authentication is enabled.</p>
        {error && <div className="message error">{error}</div>}
        <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button className="button primary" type="submit">Continue</button>
      </form>
    </main>
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
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
    <form className="password-auth-form" onSubmit={(event) => void signIn(event)}>
      <label>
        <span>Email</span>
        <input
          type="email"
          autoComplete="username"
          maxLength={320}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label>
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <button className="button primary" disabled={busy} type="submit">
        {busy ? "Signing in…" : "Sign in with email"}
      </button>
      {recoveryAvailable && (
        <a className="quiet-auth-link" href="/forgot-password">
          Forgot your password?
        </a>
      )}
    </form>
  );
}

export function ForgotPassword() {
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
    <main className="center-page">
      <PageBrand label="connect" />
      <section className="auth-panel">
        <p className="eyebrow">Account recovery</p>
        <h1>{submitted ? "Check your email." : "Reset your password"}</h1>
        <p role={submitted ? "status" : undefined} aria-live={submitted ? "polite" : undefined}>{submitted
          ? "If an mdbase connect account uses that address, its one-time reset link is on the way."
          : available
            ? "Enter the email address attached to your account. The reset link expires after one hour."
            : "Password recovery is temporarily unavailable. You can still return to sign in."}</p>
        {error && <div className="message error" role="alert">{error}</div>}
        {!submitted && available && (
          <form className="password-auth-form" onSubmit={(event) => void requestReset(event)}>
            <label>
              <span>Email</span>
              <input
                type="email"
                autoComplete="username"
                autoFocus
                maxLength={320}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy} type="submit">
              {busy ? "Sending link…" : "Send reset link"}
            </button>
          </form>
        )}
        <a className="quiet-auth-link" href="/login">Return to sign in</a>
      </section>
    </main>
  );
}

export function ResetPassword() {
  const [resetToken] = useState(() => tokenFromFragment("reset"));
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
    if (password !== passwordConfirmation) {
      setError("Passwords do not match.");
      return;
    }
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
    <main className="center-page">
      <PageBrand label="connect" />
      <section className="auth-panel">
        <p className="eyebrow">Account recovery</p>
        <h1>{completed
          ? "Password changed."
          : ready
            ? "Choose a new password"
            : "This reset link can’t be opened"}</h1>
        <p role={completed ? "status" : undefined} aria-live={completed ? "polite" : undefined}>{completed
          ? "Your other browser sessions have been signed out. This browser is now signed in with the new password."
          : ready
            ? "Replacing your password signs out every other browser session connected to the account."
            : resetToken
              ? "The link is invalid, expired, already used, or password sign-in is temporarily unavailable."
              : "Open the complete password reset link from your email."}</p>
        {error && <div className="message error" role="alert">{error}</div>}
        {!completed && ready && (
          <form className="password-auth-form" onSubmit={(event) => void resetPassword(event)}>
            <label>
              <span>New password</span>
              <input
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
            </label>
            <p className="field-note" id="reset-password-guidance">
              Use at least 15 characters. Spaces are welcome.
            </p>
            <label>
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={15}
                maxLength={1024}
                required
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy} type="submit">
              {busy ? "Changing password…" : "Change password"}
            </button>
          </form>
        )}
        {completed
          ? <a className="button secondary auth-complete-action" href="/">Open your account</a>
          : <a className="quiet-auth-link" href="/login">Return to sign in</a>}
      </section>
    </main>
  );
}

export function Signup() {
  const [invitationToken] = useState(invitationTokenFromFragment);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [agreementsAccepted, setAgreementsAccepted] = useState(false);
  const [error, setError] = useState("");
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
        if (
          !invitationToken
          || !authentication.password_registration
          || !authentication.agreements
        ) return;
        const result = await api<{ invitation: InvitationPreview }>(
          "/v1/auth/password/invitation",
          {
            method: "POST",
            body: JSON.stringify({ invitation_token: invitationToken })
          }
        );
        setInvitation(result.invitation);
      } catch (reason) {
        setError(message(reason));
      } finally {
        setLoading(false);
      }
    }
    void prepare();
  }, [invitationToken]);

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    if (!config?.agreements || !invitation) return;
    if (password !== passwordConfirmation) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/v1/auth/password/signup", {
        method: "POST",
        body: JSON.stringify({
          invitation_token: invitationToken,
          name,
          password,
          terms_version: config.agreements.terms.version,
          privacy_version: config.agreements.privacy.version
        })
      });
      location.href = returnTarget();
    } catch (reason) {
      setError(message(reason));
      setBusy(false);
    }
  }

  if (loading || !config) return <Loading error={error} />;
  const ready = Boolean(
    invitation
    && config.password_registration
    && config.agreements
  );
  return (
    <main className="center-page">
      <PageBrand label="connect" />
      <section className="auth-panel">
        <p className="eyebrow">Private preview / invitation</p>
        <h1>{ready ? "Create your account" : "This invitation can’t be opened"}</h1>
        <p>{ready
          ? "Your email is already verified by this one-time invitation. Choose the name and password you’ll use for mdbase connect."
          : invitationToken
            ? "The link is invalid, expired, already used, or account setup is temporarily unavailable."
            : "Open the complete account setup link from your invitation email."}</p>
        {error && <div className="message error" role="alert">{error}</div>}
        {ready && invitation && config.agreements && (
          <form className="password-auth-form signup-form" onSubmit={(event) => void createAccount(event)}>
            <label>
              <span>Email</span>
              <input
                type="email"
                autoComplete="username"
                readOnly
                value={invitation.email}
              />
            </label>
            <label>
              <span>Name</span>
              <input
                autoComplete="name"
                maxLength={100}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={15}
                maxLength={1024}
                aria-describedby="password-guidance"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <p className="field-note" id="password-guidance">
              Use at least 15 characters. Spaces are welcome.
            </p>
            <label>
              <span>Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={15}
                maxLength={1024}
                required
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
              />
            </label>
            <label className="auth-agreement">
              <input
                type="checkbox"
                required
                checked={agreementsAccepted}
                onChange={(event) => setAgreementsAccepted(event.target.checked)}
              />
              <span>
                I agree to the{" "}
                <a href={config.agreements.terms.url} target="_blank" rel="noreferrer">
                  Terms of Service
                </a>{" "}
                and have read the{" "}
                <a href={config.agreements.privacy.url} target="_blank" rel="noreferrer">
                  Privacy Policy
                </a>.
              </span>
            </label>
            <button
              className="button primary"
              disabled={busy || !agreementsAccepted}
              type="submit"
            >
              {busy ? "Creating account…" : "Create account"}
            </button>
          </form>
        )}
        <a className="quiet-auth-link" href="/login">Return to sign in</a>
      </section>
    </main>
  );
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
        theme: "outline";
        size: "large";
        text: "continue_with";
        shape: "rectangular";
        logo_alignment: "left";
        width: number;
      }): void;
    };
  };
}

let googleLibrary: Promise<GoogleAccountsApi> | null = null;

function GoogleSignIn({ returnTo, onError }: { returnTo: string; onError(value: string): void }) {
  return <GoogleIdentityButton
    startUrl={`/auth/google?return_to=${encodeURIComponent(returnTo)}`}
    onComplete={(redirectTo) => { location.href = redirectTo; }}
    onError={onError}
  />;
}

export function GoogleIdentityButton({ startUrl, onComplete, onError }: {
  startUrl: string;
  onComplete(redirectTo: string): void;
  onError(value: string): void;
}) {
  const button = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    async function prepare() {
      try {
        setReady(false);
        const start = await api<{ client_id: string; nonce: string }>(startUrl);
        const google = await loadGoogleIdentityServices();
        if (!active || !button.current) return;
        button.current.replaceChildren();
        google.accounts.id.initialize({
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
              setBusy(false);
              setAttempt((value) => value + 1);
            });
          }
        });
        const width = Math.min(400, Math.max(240, Math.floor(button.current.clientWidth)));
        google.accounts.id.renderButton(button.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width
        });
        setReady(true);
      } catch (reason) {
        if (active) onError(message(reason));
      }
    }
    void prepare();
    return () => { active = false; };
  }, [attempt, onComplete, onError, startUrl]);

  return <div className={`google-provider ${busy ? "busy" : ""}`} aria-busy={busy}>
    <div ref={button} className="google-button" />
    {!ready && <span className="provider-loading">Preparing Google sign-in…</span>}
  </div>;
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
      else reject(new Error("Google sign-in did not load correctly."));
    };
    script.onerror = () => reject(new Error("Google sign-in could not be loaded."));
    document.head.append(script);
  });
  return googleLibrary;
}
