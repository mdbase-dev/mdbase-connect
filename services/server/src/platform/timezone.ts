export function isIanaTimezone(value: string): boolean {
  if (!value || value.toLowerCase() === "local" || value.length > 64 || !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) {
    return false;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
