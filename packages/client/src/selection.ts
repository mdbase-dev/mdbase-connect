import {
  cleanAuthorizationParameters,
  isAuthorizationCallbackUrl
} from "./authorization-url.js";
import { connectError } from "./errors.js";

export type MdbaseSelectionHistory = "push" | "replace";

export interface MdbaseApplicationSelection {
  selectedCollectionId(): string | null;
  select(collectionId: string | null, options?: { history?: MdbaseSelectionHistory }): void;
  authorizationReturnTo(): string | undefined;
  authorizationCallback(): string | null;
  finishAuthorization(returnTo: string | undefined, collectionId: string): void;
  clearAuthorizationCallback(returnTo?: string): void;
  subscribe(listener: () => void): () => void;
}

export interface MdbaseBrowserSelectionOptions {
  collectionParameter?: string;
  fallbackPath?: string;
}

/** URL-backed collection selection for browser and browser-shell applications. */
export class MdbaseBrowserSelection implements MdbaseApplicationSelection {
  private readonly collectionParameter: string;
  private readonly fallbackPath: string;
  private readonly listeners = new Set<() => void>();
  private readonly handlePopState = () => this.emit();

  constructor(options: MdbaseBrowserSelectionOptions = {}) {
    this.collectionParameter = options.collectionParameter ?? "collection";
    this.fallbackPath = options.fallbackPath ?? "/";
  }

  selectedCollectionId(): string | null {
    return this.currentUrl().searchParams.get(this.collectionParameter);
  }

  select(
    collectionId: string | null,
    options: { history?: MdbaseSelectionHistory } = {}
  ): void {
    const url = cleanAuthorizationParameters(this.currentUrl());
    if (collectionId) url.searchParams.set(this.collectionParameter, collectionId);
    else url.searchParams.delete(this.collectionParameter);
    const browserHistory = this.browserHistory();
    browserHistory[options.history === "push" ? "pushState" : "replaceState"](
      browserHistory.state,
      "",
      url
    );
    this.emit();
  }

  authorizationReturnTo(): string {
    const url = cleanAuthorizationParameters(this.currentUrl());
    return `${url.pathname}${url.search}${url.hash}`;
  }

  authorizationCallback(): string | null {
    const value = this.currentUrl().href;
    return isAuthorizationCallbackUrl(value) ? value : null;
  }

  finishAuthorization(returnTo: string | undefined, collectionId: string): void {
    const url = this.safeAppUrl(returnTo ?? this.fallbackPath);
    cleanAuthorizationParameters(url);
    url.searchParams.set(this.collectionParameter, collectionId);
    const browserHistory = this.browserHistory();
    browserHistory.replaceState(null, "", url);
    this.emit();
  }

  clearAuthorizationCallback(returnTo?: string): void {
    const url = returnTo ? this.safeAppUrl(returnTo) : this.currentUrl();
    const browserHistory = this.browserHistory();
    browserHistory.replaceState(browserHistory.state, "", cleanAuthorizationParameters(url));
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (first && typeof window !== "undefined") {
      window.addEventListener("popstate", this.handlePopState);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && typeof window !== "undefined") {
        window.removeEventListener("popstate", this.handlePopState);
      }
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private safeAppUrl(value: string): URL {
    const current = this.currentUrl();
    const candidate = new URL(value, current.origin);
    return candidate.origin === current.origin
      ? candidate
      : new URL(this.fallbackPath, current.origin);
  }

  private currentUrl(): URL {
    if (typeof location === "undefined") {
      throw connectError("browser_required", "Browser selection requires a browser environment.");
    }
    return new URL(location.href);
  }

  private browserHistory(): History {
    if (typeof history === "undefined") {
      throw connectError("browser_required", "Browser selection requires a browser environment.");
    }
    return history;
  }
}

export class MdbaseMemorySelection implements MdbaseApplicationSelection {
  private collectionId: string | null = null;
  private readonly listeners = new Set<() => void>();

  selectedCollectionId(): string | null {
    return this.collectionId;
  }

  select(collectionId: string | null): void {
    if (collectionId === this.collectionId) return;
    this.collectionId = collectionId;
    for (const listener of this.listeners) listener();
  }

  authorizationReturnTo(): undefined {
    return undefined;
  }

  authorizationCallback(): null {
    return null;
  }

  finishAuthorization(_returnTo: string | undefined, collectionId: string): void {
    this.select(collectionId);
  }

  clearAuthorizationCallback(): void {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
