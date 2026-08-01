import { createHash } from "node:crypto";

export class SeededRandom {
  constructor(seed) {
    this.seed = String(seed);
    this.state = createHash("sha256").update(this.seed).digest().readUInt32LE(0) || 1;
  }

  next() {
    this.state |= 0;
    this.state = this.state + 0x6d2b79f5 | 0;
    let value = this.state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  }

  chance(probability) {
    return this.next() < probability;
  }

  integer(minimum, maximum) {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
      throw new Error(`Invalid random integer range ${minimum}..${maximum}`);
    }
    return minimum + Math.floor(this.next() * (maximum - minimum + 1));
  }

  pick(values) {
    if (values.length === 0) throw new Error("Cannot choose from an empty list");
    return values[this.integer(0, values.length - 1)];
  }

  weighted(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    let cursor = this.next() * total;
    for (const entry of entries) {
      cursor -= entry.weight;
      if (cursor < 0) return entry.value;
    }
    return entries.at(-1).value;
  }
}

export function deterministicUuid(seed, namespace, ordinal) {
  const hex = createHash("sha256")
    .update(`${seed}:${namespace}:${ordinal}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(value));
  if (!match) throw new Error(`Invalid duration ${value}; use values such as 500ms, 30s, 5m, or 8h`);
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Number.parseFloat(match[1]) * multipliers[match[2]];
}
