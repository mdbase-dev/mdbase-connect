export const slotMs = 1_036_800_000;
export const firstSlot = 1700;
export const pin = "0123456789abcdef".repeat(4);
export const server = `https://127.0.0.1:443#sha256=${pin}`;
export const bearer = "fe".repeat(32);
export const hashes = [pin, ...Array.from({ length: 31 }, (_, i) => (i + 1).toString(16).padStart(64, "0"))];
export const bundle = ["WTP1", bearer, firstSlot, ...hashes].join(".");
export const token = JSON.stringify([server, bundle]);
