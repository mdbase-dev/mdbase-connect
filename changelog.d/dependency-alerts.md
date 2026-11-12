## Security

- Update the Connect server and MCP server dependencies to published security fixes: fastify 5.12.8, @fastify/static 10.1.10 (glob 14), hono 4.13.17, @hono/node-server 2.1.6, fast-uri 3.1.9 and 4.2.3, ip-address 10.7.6 and qs 6.17.1. Exact overrides that held hono, @hono/node-server, find-my-way, fast-uri and ip-address at older versions are removed.
- Update development and test tooling to published security fixes: vitest 4.1.12 in the workspace, vite 7.3.8 in the SDK's tests, js-yaml 4.3.2 in the `mdbase` package's tests, and undici 7.30.1 and sharp 0.35.5 under the local Worker simulator used by the hosted Worker and log Durable Object tests.
