export interface SelectiveSyncPolicyInput {
  file_classes: Array<"image" | "audio" | "video" | "pdf" | "other">;
  excluded_folders: string[];
}

export function selectiveSyncPolicy(value: unknown): SelectiveSyncPolicyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid selective sync settings.");
  }
  const policy = value as Record<string, unknown>;
  const allowed = new Set(["image", "audio", "video", "pdf", "other"]);
  if (
    !Array.isArray(policy.file_classes)
    || policy.file_classes.some((item) => typeof item !== "string" || !allowed.has(item))
    || !Array.isArray(policy.excluded_folders)
    || policy.excluded_folders.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("Invalid selective sync settings.");
  }
  return {
    file_classes: [...new Set(policy.file_classes)] as SelectiveSyncPolicyInput["file_classes"],
    excluded_folders: [...new Set(policy.excluded_folders as string[])]
  };
}
