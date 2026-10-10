/**
 * A local, synchronous password strength estimate for the account-key setup UI
 * (AK1 §2.2, §7): a zxcvbn-style 0–4 score with feedback. It is conservative on
 * purpose: it charges dictionary-like letter runs, common passwords, sequences,
 * repeats and years far below their brute-force size, so a long but guessable
 * password does not pass. `acceptable` also applies the length policy. The server
 * never sees the password; this is the only strength check there is.
 */
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_CHARS } from "./account-key.js";

export interface Strength {
  /** 0 (guessable in under 10^3 tries) … 4 (over 10^10). */
  score: 0 | 1 | 2 | 3 | 4;
  /** Score at least 3 and within the length policy. */
  acceptable: boolean;
  /** What would make it stronger; empty when acceptable. */
  feedback: string[];
  /** Estimated log2 of the guesses needed. */
  bits: number;
}

// The most common passwords and keyboard rows (lower case). Matched as whole letter or
// digit runs, case-insensitive, with digits/symbols substituted back (p@ssw0rd).
const COMMON = new Set([
  "password", "passwort", "passw0rd", "letmein", "welcome", "admin", "administrator", "login", "master", "monkey", "dragon",
  "football", "baseball", "soccer", "hockey", "qwerty", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm", "azerty",
  "iloveyou", "sunshine", "princess", "shadow", "superman", "batman", "michael", "jennifer", "jessica", "charlie", "thomas",
  "trustno1", "abc", "abcd", "abcdef", "abcdefg", "abcdefgh", "secret", "freedom", "whatever", "starwars", "pokemon", "computer",
  "internet", "hello", "mustang", "ginger", "cheese", "summer", "winter", "spring", "autumn", "flower", "killer", "hunter",
  "ranger", "buster", "soccer", "tigger", "pepper", "jordan", "harley", "robert", "matthew", "daniel", "andrew", "joshua",
  "ashley", "nicole", "chelsea", "amanda", "orange", "purple", "yellow", "silver", "golden", "cookie", "chocolate", "mdbase",
  "tasknotes", "obsidian", "recovery", "private", "encryption", "unlock", "account", "default", "changeme", "temp", "test",
  "testing", "guest", "root", "user", "system", "server", "database", "oracle", "google", "apple", "facebook", "twitter",
  "github", "linkedin", "amazon", "netflix", "spotify", "windows", "android", "iphone", "samsung", "nokia", "sony",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "spider", "lovely", "liverpool", "arsenal",
  "chelsea", "manchester", "barcelona", "madrid", "america", "london", "paris", "berlin", "sydney", "melbourne", "canada",
]);
const COMMON_DIGITS = new Set(["123", "1234", "12345", "123456", "1234567", "12345678", "123456789", "1234567890", "111111",
  "000000", "123123", "654321", "696969", "112233", "121212", "131313", "007", "666", "777", "888", "999", "420", "69"]);
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "+": "t" };
const SEQ = "abcdefghijklmnopqrstuvwxyz0123456789";
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"];

const log2 = (x: number) => Math.log2(Math.max(1, x));

/** Is `s` (lower case, length ≥ 3) a straight run in the alphabet, digits or a keyboard row, either way? */
function sequence(s: string): boolean {
  if (s.length < 3) return false;
  const rev = [...s].reverse().join("");
  return [SEQ, ...ROWS].some((row) => row.includes(s) || row.includes(rev));
}

/** The shortest unit whose repetition is `s`, or `null`. */
function repeatUnit(s: string): string | null {
  for (let n = 1; n <= s.length / 2; n++) {
    if (s.length % n === 0 && s.slice(0, n).repeat(s.length / n) === s) return s.slice(0, n);
  }
  return null;
}

function runs(s: string): { kind: "letter" | "digit" | "symbol" | "other"; text: string }[] {
  const out: { kind: "letter" | "digit" | "symbol" | "other"; text: string }[] = [];
  for (const ch of s) {
    const kind = /\p{L}/u.test(ch) ? "letter" : /\p{Nd}/u.test(ch) ? "digit" : ch.charCodeAt(0) < 128 ? "symbol" : "other";
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += ch;
    else out.push({ kind, text: ch });
  }
  return out;
}

/** Bits for one run, with the reasons it was charged low. */
function runBits(kind: string, text: string, seen: Set<string>, why: Set<string>): number {
  const lower = text.toLowerCase();
  if (seen.has(lower)) {
    why.add("repeat");
    return 1;
  }
  seen.add(lower);
  const unit = repeatUnit(lower);
  if (unit && unit.length < lower.length) {
    why.add("repeat");
    return runBits(kind, unit, new Set(), why) + log2(lower.length / unit.length);
  }
  if (kind === "letter") {
    const deleet = [...lower].map((c) => LEET[c] ?? c).join("");
    if (COMMON.has(lower) || COMMON.has(deleet)) {
      why.add("common");
      return log2(COMMON.size) + 1;
    }
    if (sequence(lower)) {
      why.add("sequence");
      return log2(SEQ.length) + log2(lower.length) + 1;
    }
    // Roughly the guessability of a real word per letter, not the alphabet size.
    let bits = 2.5 * [...lower].length;
    if (lower !== text && text.toUpperCase() !== text) bits += 1 + log2([...text].length); // mixed case
    else if (text.toUpperCase() === text && text.length > 1) bits += 1; // all caps
    return bits;
  }
  if (kind === "digit") {
    if (COMMON_DIGITS.has(lower) || sequence(lower)) {
      why.add("sequence");
      return 4;
    }
    if (/^(19|20)\d\d$/.test(lower) || /^\d{6}$/.test(lower) || /^\d{8}$/.test(lower)) {
      why.add("date");
      return 6;
    }
    return 3.32 * lower.length;
  }
  if (kind === "symbol") {
    // Spaces (passphrases) and the usual trailing punctuation are nearly free; other symbols count.
    return [...text].reduce((n, c) => n + (c === " " ? 1 : "!?.,*#-_".includes(c) ? 2 : 5), 0);
  }
  return 7 * [...text].length; // non-ASCII letters-like symbols, emoji
}

/**
 * Split the password into dictionary hits (after undoing leet substitutions over the
 * whole string, so `P@ssw0rd` is still `password`) and the spans between them.
 */
function tokens(normalized: string): { word: string | null; text: string }[] {
  const chars = [...normalized];
  const deleet = chars.map((c) => LEET[c.toLowerCase()] ?? c.toLowerCase());
  const out: { word: string | null; text: string }[] = [];
  let span = "";
  let i = 0;
  while (i < chars.length) {
    let hit: string | null = null;
    for (let n = Math.min(24, chars.length - i); n >= 4; n--) {
      const w = deleet.slice(i, i + n).join("");
      if (COMMON.has(w)) {
        hit = w;
        break;
      }
    }
    if (hit) {
      if (span) out.push({ word: null, text: span });
      span = "";
      out.push({ word: hit, text: chars.slice(i, i + [...hit].length).join("") });
      i += [...hit].length;
    } else {
      span += chars[i];
      i++;
    }
  }
  if (span) out.push({ word: null, text: span });
  return out;
}

/** The strength of `password`; local and synchronous. Never logs or stores it. */
export function passwordStrength(password: string): Strength {
  if (typeof password !== "string") password = "";
  const bytesBefore = new TextEncoder().encode(password).length;
  const normalized = password.normalize("NFKC");
  const chars = [...normalized].length;
  const bytes = new TextEncoder().encode(normalized).length;
  const why = new Set<string>();
  const seen = new Set<string>();
  let bits = 0;
  let parts = 0;
  const kinds = new Set<string>();
  for (const t of tokens(normalized)) {
    if (t.word) {
      why.add("common");
      parts++;
      kinds.add("word");
      const lower = t.text.toLowerCase();
      bits += seen.has(t.word) ? 1 : log2(COMMON.size) + 1 + (lower !== t.text ? 1 : 0) + (lower !== t.word ? 1 : 0);
      seen.add(t.word);
      continue;
    }
    for (const r of runs(t.text)) {
      parts++;
      kinds.add(r.kind);
      bits += runBits(r.kind, r.text, seen, why);
    }
  }
  // Mixing classes adds structure guesses but is capped; the parts already paid for their content.
  bits += Math.max(0, kinds.size - 1) + log2(Math.max(1, parts));
  const score: Strength["score"] = bits < log2(1e3) ? 0 : bits < log2(1e6) ? 1 : bits < log2(1e8) ? 2 : bits < log2(1e10) ? 3 : 4;
  const feedback: string[] = [];
  const tooLong = bytesBefore > MAX_PASSWORD_BYTES || bytes > MAX_PASSWORD_BYTES;
  if (chars < MIN_PASSWORD_CHARS) feedback.push(`Use at least ${MIN_PASSWORD_CHARS} characters.`);
  if (tooLong) feedback.push("The password is too long.");
  if (why.has("common")) feedback.push("Avoid common words and passwords.");
  if (why.has("sequence")) feedback.push("Avoid sequences like abcd, 1234 or qwerty.");
  if (why.has("repeat")) feedback.push("Avoid repeated characters or words.");
  if (why.has("date")) feedback.push("Avoid years and dates.");
  if (score < 3 && feedback.length === 0) feedback.push("Add another word or two; uncommon words are best.");
  const acceptable = score >= 3 && chars >= MIN_PASSWORD_CHARS && !tooLong;
  return { score, acceptable, feedback: acceptable ? [] : feedback, bits: Math.round(bits * 10) / 10 };
}
