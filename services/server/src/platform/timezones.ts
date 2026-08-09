import { z } from "zod";

export const ianaTimezoneSchema = z.string().trim().min(1).refine((timezone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone.toLowerCase() !== "local" && !/^[+-]\d{2}:\d{2}$/.test(timezone);
  } catch {
    return false;
  }
}, "timezone must be a valid IANA identifier");
