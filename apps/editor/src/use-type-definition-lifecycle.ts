import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectionDescription } from "@mdbase-dev/connect";
import { gatewayError } from "./gateway";
import type { CollectionGateway, TypeDocument } from "./model";

interface Options {
  gateway: CollectionGateway;
  publishDescription(description: CollectionDescription): void;
  selectName(name: string | undefined): void;
  notify(message: string): void;
}

export function useTypeDefinitionLifecycle({ gateway, publishDescription, selectName, notify }: Options) {
  const [document, setDocument] = useState<TypeDocument>();
  const [source, setSourceState] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const operation = useRef(0);

  const supersede = useCallback(() => {
    operation.current += 1;
    setLoading(false);
    setSaving(false);
    return operation.current;
  }, []);

  useEffect(() => () => { operation.current += 1; }, []);

  const reset = useCallback(() => {
    supersede();
    setDocument(undefined);
    setSourceState("");
    setCreating(false);
    setError(undefined);
  }, [supersede]);

  const load = useCallback(async (name: string) => {
    const current = supersede();
    setCreating(false);
    setLoading(true);
    setError(undefined);
    setDocument(undefined);
    setSourceState("");
    try {
      const next = await gateway.readType(name);
      if (current !== operation.current) return;
      setDocument(next);
      setSourceState(next.document);
    } catch (cause) {
      if (current === operation.current) setError(gatewayError(cause));
    } finally {
      if (current === operation.current) setLoading(false);
    }
  }, [gateway, supersede]);

  const beginCreate = useCallback((initialSource: string) => {
    supersede();
    setDocument(undefined);
    setSourceState(initialSource);
    setCreating(true);
    setError(undefined);
  }, [supersede]);

  const clear = useCallback(() => {
    supersede();
    setCreating(false);
    setDocument(undefined);
    setSourceState("");
    setError(undefined);
  }, [supersede]);

  const save = useCallback(async () => {
    if (!creating && !document) return;
    const current = supersede();
    const wasCreating = creating;
    const savedSource = source;
    const existing = document;
    setSaving(true);
    setError(undefined);
    try {
      const saved = wasCreating
        ? await gateway.createType(savedSource)
        : await gateway.updateType(existing!, savedSource);
      if (current !== operation.current) return;
      setCreating(false);
      setDocument(saved);
      setSourceState(saved.document);
      const description = await gateway.describe();
      if (current !== operation.current) return;
      publishDescription(description);
      selectName(saved.name);
      notify(wasCreating ? `Created type “${saved.name}”.` : `Saved type “${saved.name}”.`);
    } catch (cause) {
      if (current === operation.current) setError(gatewayError(cause));
    } finally {
      if (current === operation.current) setSaving(false);
    }
  }, [creating, document, gateway, notify, publishDescription, selectName, source, supersede]);

  const setSource = useCallback((next: string) => {
    setSourceState(next);
    setError(undefined);
  }, []);
  const discardChanges = useCallback(() => {
    if (document) setSourceState(document.document);
    setError(undefined);
  }, [document]);

  return { document, source, creating, loading, saving, error, load, save, reset, clear,
    beginCreate, setSource, discardChanges, setError };
}
