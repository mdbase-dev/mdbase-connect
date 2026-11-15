export function buildIdentity(id: string | undefined): string;
export function buildIdentityTag(id: string | undefined): string;
export function stampBuildIdentity(directory: string, id: string | undefined): Promise<string[]>;
export function assertBuildIdentity(directory: string, inventory: readonly { path: string }[], id: string | undefined): Promise<void>;
export function buildIdentityPlugin(id: string | undefined): {
  name: string;
  apply: "build";
  configResolved(config: { root: string; build: { outDir: string } }): void;
  writeBundle(): Promise<void>;
};
