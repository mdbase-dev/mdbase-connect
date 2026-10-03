import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

for (const existing of [false, true]) {
  test(`tracking issue ${existing ? "reopens only the bot-owned marker issue" : "creates when no owned marker exists"}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "flake-issue-"));
    try {
      writeFileSync(join(directory, "results.jsonl"), JSON.stringify({ suite: "suite", test: "exact name", platform: "linux", iteration: "3", recovered: false }) + "\n");
      const source = `
        const requests = [];
        let page = 0;
        const marker = '<!-- ci-flake-stress-tracker -->';
        globalThis.fetch = async (url, options) => {
          requests.push({ url, ...options });
          if (options.method === 'GET') {
            page++;
            const unrelated = { number: 1, body: marker, user: { login: 'human' } };
            const first = Array.from({ length: 100 }, () => unrelated);
            first[0] = { ...unrelated, user: { login: 'github-actions[bot]' }, pull_request: {} };
            first[1] = { ...unrelated, user: { login: 'github-actions[bot]' }, body: 'unrelated issue' };
            const owned = { number: 42, body: marker, user: { login: 'github-actions[bot]' }, state: 'closed', html_url: 'https://github.com/example/test/issues/42' };
            return new Response(JSON.stringify(page === 1 ? first : ${existing} ? [owned] : []));
          }
          return new Response(JSON.stringify({ number: 42 }), { status: 200 });
        };
        process.argv[2] = ${JSON.stringify(directory)};
        await import(${JSON.stringify(new URL("./track-flakes.mjs", import.meta.url).href)});
        console.log(JSON.stringify(requests));
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
        encoding: "utf8", env: { ...process.env, GH_TOKEN: "fixture-token", GITHUB_REPOSITORY: "example/test", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "123" }
      });
      assert.equal(result.status, 0, result.stderr);
      const requests = JSON.parse(result.stdout.trim());
      assert.equal(requests.length, 3);
      assert.ok(requests.every((request) => request.url.startsWith("https://api.github.com/repos/example/test/")));
      assert.ok(requests[1].url.endsWith("page=2"));
      assert.equal(requests[2].method, existing ? "PATCH" : "POST");
      assert.ok(requests[2].url.endsWith(existing ? "issues/42" : "issues"));
      assert.equal(requests[2].headers["Content-Type"], "application/json");
      const payload = JSON.parse(requests[2].body);
      assert.equal(payload.state, existing ? "open" : undefined);
      assert.ok(payload.body.includes("suite :: exact name"));
      assert.ok(payload.body.includes("actions/runs/123"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
