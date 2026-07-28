const accountId = required("CLOUDFLARE_ACCOUNT_ID");
const apiToken = required("CLOUDFLARE_API_TOKEN");
const projectName = required("CLOUDFLARE_PAGES_PROJECT");
const domainName = required("CLOUDFLARE_PAGES_DOMAIN");

const apiBase = "https://api.cloudflare.com/client/v4";
const projectPath = `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}`;
const domainPath = `${projectPath}/domains/${encodeURIComponent(domainName)}`;
const headers = {
  accept: "application/json",
  authorization: `Bearer ${apiToken}`
};

const current = await cloudflare(domainPath, { headers }, [404]);
if (current.response.ok && current.body.result?.name === domainName) {
  console.log(`Cloudflare Pages domain already attached: ${domainName}`);
  process.exit(0);
}

const created = await cloudflare(`${projectPath}/domains`, {
  method: "POST",
  headers: {
    ...headers,
    "content-type": "application/json"
  },
  body: JSON.stringify({ name: domainName })
});

if (created.body.result?.name !== domainName) {
  throw new Error(`Cloudflare Pages did not return the attached domain ${domainName}.`);
}
console.log(`Cloudflare Pages domain attached: ${domainName}`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function cloudflare(path, options, allowedStatuses = []) {
  const response = await fetch(`${apiBase}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (
    !response.ok
    && !allowedStatuses.includes(response.status)
  ) {
    const errors = Array.isArray(body.errors)
      ? body.errors.map((error) => error.message).filter(Boolean).join("; ")
      : "";
    throw new Error(
      `Cloudflare API request failed with HTTP ${response.status}${errors ? `: ${errors}` : "."}`
    );
  }
  if (response.ok && body.success !== true) {
    throw new Error("Cloudflare API returned an unsuccessful response.");
  }
  return { response, body };
}
