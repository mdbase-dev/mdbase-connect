export async function cleanDirectEntry(origin: string, page: Window = window): Promise<boolean> {
  try {
    const workers = page.navigator.serviceWorker;
    const clean = () => page === page.top && page.location.href === `${origin}/` && !workers?.controller;
    // A browser without the service worker API has no worker that could intercept this page.
    return clean() && (!workers || (await workers.getRegistrations()).length === 0) && clean();
  } catch {
    return false;
  }
}
