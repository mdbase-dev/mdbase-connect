export function declarationIdFromFamilyIdentity(familyIdentity: string): string {
  const prefix = "bundle:";
  if (!familyIdentity.startsWith(prefix) || familyIdentity.length === prefix.length) {
    throw new Error("Registered application family identity is invalid.");
  }
  return familyIdentity.slice(prefix.length);
}
