## Fixed

- A failed first `pnpm install` in the Desktop release build no longer leaves a half-installed tool behind: the single retry now starts from clean `node_modules`.
