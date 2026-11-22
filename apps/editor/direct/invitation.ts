// Validate the complete invitation before unwrapping its encoded backend descriptor.
export function invitationServer(link: string, origin: string): string {
  const prefix = origin + "/#mdbase-pair=";
  if (!origin.startsWith("https://") || !link.startsWith(prefix)) throw Error("Invalid invitation");
  const encoded = link.slice(prefix.length);
  if (/[#/?&=:]/u.test(encoded)) throw Error("Invalid invitation");
  const descriptor = decodeURIComponent(encoded);
  if (!/^https:\/\/[^/?#@\s\\]+#sha256=[a-f0-9]{64}$/u.test(descriptor) || /\s/u.test(descriptor))
    throw Error("Invalid invitation");
  return descriptor;
}

export function takePairInvitation(page: Window = window): string | undefined {
  const { hash, href, origin } = page.location;
  if (!hash.startsWith("#mdbase-pair")) return;
  page.history.replaceState(null, "", "/");
  if (page !== page.top) throw Error("Invalid invitation");
  return invitationServer(href, origin);
}

export function backendHost(server: string): string {
  return new URL(server).host;
}

export function onPairInvitation(receive: (descriptor?: string) => void) {
  const handle = (event: Event) => {
    if (!location.hash.startsWith("#mdbase-pair")) return;
    event.stopImmediatePropagation();
    let descriptor;
    try { descriptor = takePairInvitation(); } catch { /* Report without echoing the link. */ }
    receive(descriptor);
  };
  window.addEventListener("popstate", handle, true);
  window.addEventListener("hashchange", handle, true);
  return () => {
    window.removeEventListener("popstate", handle, true);
    window.removeEventListener("hashchange", handle, true);
  };
}
