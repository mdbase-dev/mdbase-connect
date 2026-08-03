import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { chromium } from "@playwright/test";

const bundle = await readFile(
  new URL("../dist/browser/mdbase-connect.min.js", import.meta.url)
);
const server = createServer((request, response) => {
  if (request.url === "/sdk.js") {
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(bundle);
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(
    "<!doctype html><meta charset=utf-8><title>client storage test</title>"
      + "<script src=/sdk.js></script>"
  );
});
const profileDirectory = await mkdtemp(
  join(tmpdir(), "mdbase-connect-browser-storage-")
);
const handle = crypto.randomUUID();
let context;

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: true
  });
  const firstPage = context.pages()[0] ?? await context.newPage();
  const secondPage = await context.newPage();
  await Promise.all([firstPage.goto(origin), secondPage.goto(origin)]);

  const created = await firstPage.evaluate(async (keyHandle) => {
    const store = new MdbaseConnect.IndexedDbGrantKeyStore();
    const record = await store.create(keyHandle);
    let agreementExportRejected = false;
    let signingExportRejected = false;
    try {
      await crypto.subtle.exportKey("pkcs8", record.agreementPrivateKey);
    } catch {
      agreementExportRejected = true;
    }
    try {
      await crypto.subtle.exportKey("pkcs8", record.signingPrivateKey);
    } catch {
      signingExportRejected = true;
    }
    return {
      agreementPublicKey: record.agreementPublicKey,
      signingPublicKey: record.signingPublicKey,
      agreementExtractable: record.agreementPrivateKey.extractable,
      signingExtractable: record.signingPrivateKey.extractable,
      agreementExportRejected,
      signingExportRejected
    };
  }, handle);
  assert.equal(created.agreementExtractable, false);
  assert.equal(created.signingExtractable, false);
  assert.equal(created.agreementExportRejected, true);
  assert.equal(created.signingExportRejected, true);

  const installation = await firstPage.evaluate(async (keyHandle) => {
    const store = new MdbaseConnect.IndexedDbApplicationIdentityStore();
    const record = await store.create(`installation:${keyHandle}`);
    let exportRejected = false;
    try {
      await crypto.subtle.exportKey("pkcs8", record.signingPrivateKey);
    } catch {
      exportRejected = true;
    }
    return {
      signingPublicKey: record.signingPublicKey,
      extractable: record.signingPrivateKey.extractable,
      exportRejected
    };
  }, handle);
  assert.deepEqual(
    { extractable: installation.extractable, exportRejected: installation.exportRejected },
    { extractable: false, exportRejected: true }
  );

  const restoredInSecondTab = await secondPage.evaluate(async (keyHandle) => {
    const record = await new MdbaseConnect.IndexedDbGrantKeyStore().get(keyHandle);
    if (!record) return null;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      record.signingPrivateKey,
      new TextEncoder().encode("persisted browser key")
    );
    return {
      agreementPublicKey: record.agreementPublicKey,
      signingPublicKey: record.signingPublicKey,
      signingExtractable: record.signingPrivateKey.extractable,
      signatureBytes: signature.byteLength
    };
  }, handle);
  assert.deepEqual(restoredInSecondTab, {
    agreementPublicKey: created.agreementPublicKey,
    signingPublicKey: created.signingPublicKey,
    signingExtractable: false,
    signatureBytes: 64
  });
  const restoredInstallation = await secondPage.evaluate(async (keyHandle) => {
    const record = await new MdbaseConnect.IndexedDbApplicationIdentityStore()
      .get(`installation:${keyHandle}`);
    return record && {
      signingPublicKey: record.signingPublicKey,
      extractable: record.signingPrivateKey.extractable
    };
  }, handle);
  assert.deepEqual(restoredInstallation, {
    signingPublicKey: installation.signingPublicKey,
    extractable: false
  });

  const counters = (
    await Promise.all(
      [firstPage, secondPage].map((page) =>
        page.evaluate(async ({ keyHandle, count }) => {
          const store = new MdbaseConnect.IndexedDbGrantKeyStore();
          return Promise.all(
            Array.from({ length: count }, () => store.nextCounter(keyHandle))
          );
        }, { keyHandle: handle, count: 20 })
      )
    )
  ).flat();
  assert.equal(new Set(counters).size, 40);
  assert.deepEqual(
    counters.map(BigInt).sort((left, right) => left < right ? -1 : 1),
    Array.from({ length: 40 }, (_, index) => BigInt(index + 1))
  );

  await context.close();
  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: true
  });
  const restartedPage = context.pages()[0] ?? await context.newPage();
  await restartedPage.goto(origin);
  const afterRestart = await restartedPage.evaluate(async (keyHandle) => {
    const store = new MdbaseConnect.IndexedDbGrantKeyStore();
    const record = await store.get(keyHandle);
    return {
      agreementPublicKey: record?.agreementPublicKey,
      signingPublicKey: record?.signingPublicKey,
      counter: await store.nextCounter(keyHandle)
    };
  }, handle);
  assert.deepEqual(afterRestart, {
    agreementPublicKey: created.agreementPublicKey,
    signingPublicKey: created.signingPublicKey,
    counter: "41"
  });
  const installationAfterRestart = await restartedPage.evaluate(async (keyHandle) => {
    const record = await new MdbaseConnect.IndexedDbApplicationIdentityStore()
      .get(`installation:${keyHandle}`);
    return record?.signingPublicKey;
  }, handle);
  assert.equal(installationAfterRestart, installation.signingPublicKey);
  console.log(
    "Browser key storage passed: grant and installation keys persisted non-extractably across tabs and restart; counters were atomic."
  );
} finally {
  await context?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await rm(profileDirectory, { recursive: true, force: true });
}
