import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { account, authentication, authorizationId, clock, hostedCollection, scenarios } from "./scenarios.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const dist = resolve(root, "apps/portal/dist");
const error = (message, code = "review_error") => ({ error: { code, message } });
const google = `window.google = { accounts: { id: {
  initialize(config) { this.config = config; },
  renderButton(element, config) {
    element.replaceChildren();
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'mdbase-button provider-button';
    button.style.width = config.width + 'px';
    button.innerHTML = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34a853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#ea4335" d="M12 5.96c1.47 0 2.79.5 3.82 1.49l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg>Continue with Google';
    button.onclick = () => this.config.callback({credential:'local-review-only'});
    element.append(button);
  }
} } };`;

export function reviewServer({ editorUrl = process.env.REVIEW_EDITOR_URL ?? "http://127.0.0.1:4802/?demo=300" } = {}) {
  const sessions = new Map();
  const feedback = [];
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const path = url.pathname;
    const method = request.method;
    const send = (body, status = 200, type = "application/json") => {
      response.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
      response.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    const redirect = target => { response.writeHead(302, { location: target, "cache-control": "no-store" }); response.end(); };
    try {
      if (path === "/__review") return send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect review</title>
        <h1>Connect portal review</h1><p>Local fake data only. Each selection resets this browser's state. Add ?latency=300 to slow API responses.</p>
        <ul>${scenarios.map(scenario => `<li><a href="/__review/scenario/${scenario.name}">${scenario.name}</a></li>`).join("")}</ul></html>`, 200, "text/html");
      if (path.startsWith("/__review/scenario/")) {
        const scenario = scenarios.find(scenario => path === `/__review/scenario/${scenario.name}`);
        if (!scenario) return send(error("Unknown review scenario"), 404);
        const latency = Number(url.searchParams.get("latency") ?? 60);
        if (!Number.isInteger(latency) || latency < 0 || latency > 10000) return send(error("Latency must be an integer between 0 and 10000 ms"), 400);
        const previous = request.headers.cookie?.match(/(?:^|;\s*)review=([\w-]+)/)?.[1];
        if (previous) sessions.delete(previous);
        const id = randomUUID();
        sessions.set(id, { name: scenario.name, latency, ...structuredClone(scenario.state) });
        response.setHeader("set-cookie", `review=${id}; Path=/; HttpOnly; SameSite=Lax`);
        return redirect(scenario.path);
      }
      if (path === "/__review/google.js") return send(google, 200, "application/javascript");
      if (path === "/__review/return") return send("Returned to TaskNotes", 200, "text/plain");
      if (["/__review/terms", "/__review/privacy"].includes(path)) return send("Local review agreement. No account or personal information is sent anywhere.", 200, "text/plain");
      const id = request.headers.cookie?.match(/(?:^|;\s*)review=([\w-]+)/)?.[1];
      const state = sessions.get(id);
      if (path.startsWith("/v1/") || path.startsWith("/auth/")) {
        if (!state && !(path === "/v1/feedback" && method === "POST")) return send(error("Choose a scenario at /__review"), 401);
        let raw = "";
        for await (const chunk of request) {
          raw += chunk;
          if (raw.length > 5 * 1024 * 1024) return send(error("Review request too large"), 413);
        }
        let body;
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(error("Invalid JSON"), 400); }
        await new Promise(resolve => setTimeout(resolve, state?.latency ?? 60));
        if (response.destroyed) return;
        if (path === "/v1/feedback" && method === "POST") { feedback.push(body); return send({ id: `feedback-${feedback.length}` }, 201); }
        const data = state.overview;
        const signIn = () => { state.signedIn = true; };
        const localTarget = value => {
          const target = new URL(value || "/collections", url.origin);
          return target.origin === url.origin ? `${target.pathname}${target.search}${target.hash}` : "/collections";
        };
        if (path === "/v1/auth/config") return send(authentication);
        if (path === "/auth/google" && method === "GET") {
          state.returnTo = localTarget(url.searchParams.get("return_to"));
          return send({ client_id: "local-review", nonce: "local-review" });
        }
        if ((path === "/auth/google/callback" && method === "POST") || (path === "/auth/github" && method === "GET")) {
          if (path === "/auth/github") state.returnTo = localTarget(url.searchParams.get("return_to"));
          const target = state.name === "signup" && !state.signedIn
            ? `/signup?external=1&return_to=${encodeURIComponent(state.returnTo ?? "/")}`
            : state.returnTo ?? "/collections";
          if (state.name !== "signup" || state.signedIn) signIn();
          return path === "/auth/github" ? redirect(target) : send({ redirect_to: target });
        }
        if (path === "/v1/auth/external/signup/preview" && method === "POST" && state.name === "signup") {
          return send({ proof_id: "review-external-proof", email: data.user.email, name: data.user.name });
        }
        if (path === "/v1/auth/external/signup" && method === "POST" && state.name === "signup") {
          if (body.proof_id !== "review-external-proof" || body.terms_version !== "1" || body.privacy_version !== "1") return send(error("Accept the review agreements"), 400);
          data.user.name = body.name;
          signIn();
          return send({ redirect_to: state.returnTo === "/" ? "/getting-started" : state.returnTo });
        }
        if (path === "/v1/auth/password/login" && method === "POST") { signIn(); return send({ ok: true }); }
        if (path === "/v1/auth/password/signup/verification" && method === "POST") return send({ verification: { email: state.verificationEmail ?? data.user.email } });
        if (path === "/v1/auth/password/signup/request" && method === "POST") { state.verificationEmail = body.email; return send({ ok: true }); }
        if (path === "/v1/auth/password/recovery" && method === "POST") { state.recoveryEmail = body.email; return send({ ok: true }); }
        if (path === "/v1/auth/password/reset" && method === "POST") { signIn(); return send({ ok: true }); }
        if (path === "/v1/auth/password/signup/public" && method === "POST") {
          if (body.terms_version !== "1" || body.privacy_version !== "1") return send(error("Accept the review agreements"), 400);
          data.user.name = body.name;
          data.user.email = state.verificationEmail ?? data.user.email;
          signIn(); return send({ redirect_to: "/getting-started" });
        }
        if (!state.signedIn) return send(error("Your session expired. Sign in again."), 401);
        if (path === "/v1/me" && method === "GET") return state.name === "server-500"
          ? send(error("The review server could not load your account. Try again."), 500) : send(data);
        if (path === "/v1/ui-configuration" && method === "GET") return send({ editor_url: editorUrl });
        if (path === "/v1/account/sessions" && method === "GET") return send({ sessions: state.sessions });
        if (path === "/v1/account/sessions/revoke-others" && method === "POST") { state.sessions = state.sessions.filter(session => session.current); return send({ ok: true }); }
        if (path.startsWith("/v1/account/sessions/") && method === "DELETE") { state.sessions = state.sessions.filter(session => session.id !== path.split("/").at(-1)); return send({ ok: true }); }
        if (path === "/v1/account" && method === "GET") return send({ ...account(data), authentication: state.account.authentication, email_preferences: state.account.email_preferences });
        if (path === "/v1/account/email-preferences" && method === "PATCH") { Object.assign(state.account.email_preferences, body); return send({ email_preferences: state.account.email_preferences }); }
        if (path === "/v1/account/password" && method === "PATCH") {
          state.account.authentication.password.configured = true;
          state.sessions = state.sessions.filter(session => session.current);
          return send({ ok: true });
        }
        if (path === "/v1/account" && method === "DELETE") { state.signedIn = false; return send({ ok: true }); }
        if (path === "/v1/logout" && method === "POST") { state.signedIn = false; return send({ ok: true }); }
        const createCollection = (displayName, collectionId = randomUUID()) => {
          const existing = data.hosted_collections.find(collection => collection.id === collectionId);
          if (existing) return existing;
          const collection = hostedCollection(collectionId, displayName);
          data.hosted_collections.push(collection);
          state.members[collection.id] = [{ kind: "owner", name: data.user.name, role: "owner", state: "active", accepted_at: clock }];
          state.pairing.collections.push({ collection_id: collection.id, display_name: displayName, role: "owner" });
          return collection;
        };
        if (path === "/v1/onboarding/starter-collection" && method === "POST") {
          if (state.onboarding === "failed") { state.onboarding = "ready"; return send(error("Starter collection could not be created."), 500); }
          if (state.onboarding === "pending") return send({ status: "pending" });
          if (!data.hosted_collections.length) createCollection("My first collection");
          return send({ status: "ready", collection_id: data.hosted_collections[0].id, editor_url: editorUrl });
        }
        if (["/v1/hosted/collections", "/v1/account/collections"].includes(path) && method === "POST") return send({ collection: createCollection(body.display_name, body.request_id) }, 201);
        const sharing = path.match(/^\/v1\/hosted\/collections\/([^/]+)\/(members|invitations)(?:\/([^/]+))?$/);
        if (sharing) {
          const [, collectionId, resource, itemId] = sharing;
          if (!data.hosted_collections.some(collection => collection.id === collectionId)) return send(error("Collection not found"), 404);
          if (state.name === "provider-unavailable") return send(error("The hosted provider is unavailable. Try again shortly."), 503);
          if (state.name === "sync-conflict") return send(error("Sync conflict: reconcile the Studio and Travel replicas before changing access.", "sync_conflict"), 409);
          const items = (state[resource][collectionId] ??= []);
          if (method === "GET") return send({ [resource]: items });
          if (resource === "invitations" && method === "POST") {
            const invitation = { id: randomUUID(), collection_id: collectionId, token: `cinv_${randomUUID()}`, target_mode: body.email ? "email" : "invitee_code", submitted_email: body.email ?? null, role: body.role, state: "pending", created_at: clock, expires_at: new Date(Date.parse(clock) + 7 * 24 * 60 * 60 * 1000).toISOString() };
            items.push(invitation); return send({ invitation }, 201);
          }
          const item = items.find(item => item.id === itemId);
          if (!item) return send(error("Sharing entry not found"), 404);
          if (method === "PATCH") { item.role = body.role; return send({ member: item }); }
          if (method === "DELETE") { items.splice(items.indexOf(item), 1); return send({ ok: true }); }
        }
        const pairing = path.match(/^\/v1\/pairing-requests\/([^/]+)(?:\/([^/]+))?$/);
        if (pairing) {
          const action = pairing[2];
          if (method === "GET" && !action) return state.pairingDenied
            ? send(error("This sign-in was cancelled. Start sign-in again from the app.", "installation_pairing_denied"), 404)
            : send({ pairing: state.pairing });
          if (method === "POST") {
            if (action === "select-account") {
              if (state.pairing.account_upgrade) return send(error("Account upgrade needed", "installation_legacy_backend"), 409);
              state.pairing.account_selection_confirmed = true;
            } else if (action === "collections") {
              const created = createCollection(body.display_name, state.pairing.creation?.collection_id);
              state.pairing.creation = { collection_id: created.id, display_name: created.display_name, completed: true };
              return send({ collection_id: created.id });
            } else if (action === "approve") {
              state.pairing.approved_at = clock;
              state.pairing.selected_collection_id = body.selected_collection_id;
              state.pairing.approved_collection_ids = body.collection_ids;
              state.pairing.approved_create_collections = body.create_collections;
            } else if (action === "deny") state.pairingDenied = true;
            else return send(error("Unknown pairing action"), 404);
            return send({ ok: true });
          }
        }
        if (path === "/v1/device-authorization-requests/lookup" && method === "POST") return send({ request_id: authorizationId });
        const authorization = path.match(/^\/v1\/authorization-requests\/([^/]+)(?:\/([^/]+))?$/);
        if (authorization) {
          const action = authorization[2];
          if (action === "status" && method === "GET") return send({ status: state.authorizationStatus, ...(state.authorizationRedirect ? { redirect_uri: state.authorizationRedirect } : {}) });
          if (!action && method === "GET") return send({ authorization: state.authorization,
            collections: [...data.collections.map(collection => ({ ...collection, kind: "local" })), ...data.hosted_collections.map(collection => ({ ...collection, connector_name: "Hosted by mdbase", kind: "hosted" }))],
            hosted_collections_available: true, unavailable_connectors: [{ connector_id: "computer-2", connector_name: "Travel laptop", reason: "offline" }] });
          if (method === "POST" && ["approve", "deny"].includes(action)) {
            if (action === "approve") {
              const collection = [...data.collections, ...data.hosted_collections].find(collection => collection.id === body.collection_id);
              if (!collection) return send(error("Choose an available collection"), 400);
              const app = state.authorization;
              app.collection_id = collection.id;
              data.grants.push({ id: randomUUID(), collection_id: collection.id, collection_name: collection.display_name,
                collection_kind: collection.template ? "hosted" : "local", operations: body.operations,
                application_id: app.application_id, application_name: app.application_name, application_origin: app.application_origin,
                distribution: app.distribution, homepage: app.homepage, project_url: app.project_url, icon: app.icon,
                scope: { contracts: [], access: "full_collection" }, created_at: clock, revoked_at: null,
                revocation_status: "active", reauthorization_required_at: null, reauthorization_reason: null });
            }
            state.authorizationStatus = action === "approve" ? "approved" : "denied";
            data.pending_authorizations = [];
            return send({ ok: true });
          }
        }
        if (path === "/v1/grants/revoke-batch" && method === "POST") {
          for (const grant of data.grants.filter(grant => body.grant_ids.includes(grant.id))) { grant.revoked_at = clock; grant.revocation_status = "revoked"; }
          return send({ ok: true, results: body.grant_ids.map(grant_id => ({ grant_id, status: "revoked" })) });
        }
        const resource = path.match(/^\/v1\/(hosted\/collections|connectors|grants|hosted\/replicas)\/([^/]+)$/);
        if (resource) {
          const [, kind, itemId] = resource;
          const items = kind === "hosted/collections" ? data.hosted_collections : kind === "connectors" ? data.connectors : kind === "grants" ? data.grants : data.hosted_collections.flatMap(collection => collection.replicas);
          const item = items.find(item => item.id === itemId);
          if (!item) return send(error("Review resource not found"), 404);
          if (method === "PATCH") {
            if (kind === "connectors") {
              item.name = body.name;
              for (const collection of data.collections.filter(collection => collection.connector_id === item.id)) collection.connector_name = item.name;
            }
            else if (kind === "hosted/collections") {
              item.display_name = body.display_name;
              for (const grant of data.grants.filter(grant => grant.collection_id === item.id)) grant.collection_name = item.display_name;
              const choice = state.pairing.collections.find(collection => collection.collection_id === item.id);
              if (choice) choice.display_name = item.display_name;
            } else if (kind === "grants") item.operations = body.operations;
            return send({ ok: true });
          }
          if (method === "DELETE") {
            if (kind === "grants" || kind === "hosted/replicas") { item.revoked_at = clock; item.revocation_status = "revoked"; }
            else {
              items.splice(items.indexOf(item), 1);
              if (kind === "connectors") data.collections = data.collections.filter(collection => collection.connector_id !== item.id);
              const existing = new Set([...data.collections, ...data.hosted_collections].map(collection => collection.id));
              data.grants = data.grants.filter(grant => existing.has(grant.collection_id));
              state.pairing.collections = state.pairing.collections.filter(collection => existing.has(collection.collection_id));
            }
            return send({ ok: true });
          }
        }
        return send(error(`Unmocked review endpoint: ${method} ${path}`), 501);
      }
      if (!state && path === "/") return redirect("/__review");
      const file = resolve(dist, `.${decodeURIComponent(path)}`);
      if (!file.startsWith(`${dist}${sep}`) && file !== dist) return send(error("Invalid path"), 400);
      let target = file;
      try { if (!(await stat(target)).isFile()) target = resolve(dist, "index.html"); }
      catch { if (path.startsWith("/assets/")) return send(error("Asset not found"), 404); target = resolve(dist, "index.html"); }
      let bytes = await readFile(target);
      const extension = target.split(".").at(-1);
      const mime = { html: "text/html", js: "application/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", png: "image/png", woff2: "font/woff2", ico: "image/x-icon" }[extension] ?? "application/octet-stream";
      if (extension === "html") bytes = Buffer.from(bytes.toString().replace("<head>", '<head><script src="/__review/google.js"></script>'));
      response.writeHead(200, { "content-type": mime, "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'none'" });
      response.end(bytes);
    } catch (reason) {
      if (request.aborted) return;
      console.error(reason);
      if (!response.headersSent) send(error("Review server failed; see terminal output"), 500);
      else response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 4801);
  if (!process.argv.includes("--no-build")) {
    const result = spawnSync("pnpm", ["--filter", "@mdbase/connect-portal...", "-r", "--if-present", "build"], {
      cwd: root, stdio: "inherit", env: { ...process.env, VITE_MDBASE_FEEDBACK_URL: `http://127.0.0.1:${port}/v1/feedback`, VITE_MDBASE_TURNSTILE_SITE_KEY: "" }
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  await stat(resolve(dist, "index.html"));
  const server = reviewServer();
  server.listen(port, "127.0.0.1", () => console.log(`Connect review: http://127.0.0.1:${port}/__review`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
