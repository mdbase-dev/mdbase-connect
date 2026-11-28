import { z } from "zod";
import { isIanaTimezone } from "./timezone.js";

export const ianaTimezoneSchema = z.string().trim().refine(isIanaTimezone, "timezone must be a valid IANA identifier");
