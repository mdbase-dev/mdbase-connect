import { SyncError } from "./sync-error.js";

export function validatePortableMirrorPath(path: string): void {
  const components = path.split("/");
  if (
    !path
    || path.startsWith("/")
    || path.includes("\\")
    || components.some((component) => {
      const stem = component.split(".")[0]!.toUpperCase();
      return !component
        || component === "."
        || component === ".."
        || component.endsWith(".")
        || component.endsWith(" ")
        || /[\u0000-\u001f\u007f:]/u.test(component)
        || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem);
    })
  ) {
    throw new SyncError("invalid_path", `Mirror received an unsafe path: ${path}.`);
  }
}
