import { spawnSync } from "node:child_process";

// rcargo builds on the shared build VM, which keeps Rust targets off this
// machine's disk. CI and machines without it build with local cargo.
export const useRcargo = () =>
  !process.env.CI && !spawnSync("rcargo", ["--help"], { stdio: "ignore" }).error;
