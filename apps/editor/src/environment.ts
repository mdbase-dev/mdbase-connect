// The mdbase environment this build belongs to. A development build is LAB; a
// build with no configured environment is production.
const configured = import.meta.env.VITE_MDBASE_ENV ?? (import.meta.env.DEV ? "lab" : "production");
if (configured !== "lab" && configured !== "staging" && configured !== "production") throw new Error("Invalid Editor application environment");

export const editorEnvironment: "lab" | "staging" | "production" = configured;
