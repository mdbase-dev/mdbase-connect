// The classic-script browser global retains opt-in primitives as properties;
// ESM consumers use the explicit root, /advanced, and /crypto entry points.
export * from "./index.js";
export * from "./advanced.js";
export * from "./crypto-entry.js";
