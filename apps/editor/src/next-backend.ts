import { loadOrCreateClientKey, relayConnector, type ClientKey } from "@mdbase-dev/sdk";
import { connectServerUrl } from "./connect-endpoint";
import { ProposedControlPlaneAccess, type NextAccessProvider } from "./next-access";
import { NextCollectionGateway, type NextGatewaySource } from "./next-gateway";

type NextBackend = "next" | "next-demo";

const APP = { name: "dev.mdbase.editor", version: import.meta.env.VITE_MDBASE_REVISION ?? "dev" };

/** A relay connection through whatever the control plane says (see next-access.ts). */
function relaySource(access: NextAccessProvider, key: () => Promise<ClientKey>): NextGatewaySource {
  return {
    open: async () => {
      const current = await access.current();
      if (!current) return null;
      return {
        connector: relayConnector({
          collection: current.collection,
          grant: current.grant,
          staticKey: await key(),
          resolveRoute: current.resolveRoute
        }),
        ...(current.displayName ? { displayName: current.displayName } : {})
      };
    },
    authorize: () => access.authorize(),
    forget: (collectionId) => access.forget(collectionId)
  };
}

/** Loaded on demand, so the default Connect bundle doesn't carry the SDK. */
export async function createNextGateway(backend: NextBackend): Promise<NextCollectionGateway> {
  if (backend === "next-demo") {
    const { nextDemoSource } = await import("./next-demo");
    return new NextCollectionGateway(nextDemoSource(), APP);
  }
  let key: Promise<ClientKey> | undefined;
  const clientKey = () => key ??= loadOrCreateClientKey(APP.name);
  return new NextCollectionGateway(relaySource(new ProposedControlPlaneAccess(connectServerUrl(), clientKey), clientKey), APP);
}
