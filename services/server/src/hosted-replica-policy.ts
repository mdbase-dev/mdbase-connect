/**
 * Application grants may include transport capabilities that are meaningful to
 * the SDK but are not executable collection operations at the hosted provider.
 *
 * Hosted sync authorizes each snapshot, change read, and mutation through its
 * underlying collection operation, so forwarding `sync` as an allowed
 * operation both duplicates that policy and violates the provider contract.
 */
export function hostedReplicaCollectionOperations(
  grantOperations: readonly string[]
): string[] {
  return grantOperations.filter((operation) => operation !== "sync");
}
