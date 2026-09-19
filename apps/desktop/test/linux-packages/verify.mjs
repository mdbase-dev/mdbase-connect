import { spawnSync } from "node:child_process";
import { resolve, dirname, basename } from "node:path";

// Run package-manager operations only inside disposable containers, never on the host.
// Optional previous packages exercise a real upgrade, in addition to fresh install.
const [deb, rpm, previousDeb, previousRpm] = process.argv.slice(2);
if (!deb || !rpm || Boolean(previousDeb) !== Boolean(previousRpm)) {
  throw new Error("Usage: node apps/desktop/test/linux-packages/verify.mjs current.deb current.rpm [previous.deb previous.rpm]");
}

for (const [format, artifact, previous, image] of [
  ["deb", deb, previousDeb, "ubuntu:24.04"],
  ["rpm", rpm, previousRpm, "fedora:43"]
]) {
  const mounts = ["--volume", `${dirname(resolve(artifact))}:/packages:ro`];
  if (previous) mounts.push("--volume", `${dirname(resolve(previous))}:/previous:ro`);
  const install = format === "deb"
    ? 'apt-get install -y --no-install-recommends "$package"'
    : 'dnf install -y --setopt=install_weak_deps=False "$package"';
  const reinstall = format === "deb"
    ? 'apt-get install -y --no-install-recommends --reinstall "$package"'
    : 'dnf reinstall -y --setopt=install_weak_deps=False "$package"';
  const remove = format === "deb"
    ? "apt-get purge -y mdbase-connect"
    : "dnf remove -y mdbase-connect";
  const owner = format === "deb"
    ? "dpkg-query -S /usr/bin/mdbase | grep '^mdbase-connect:'"
    : "test \"$(rpm -qf --qf '%{NAME}' /usr/bin/mdbase)\" = mdbase-connect";
  const script = `
set -eux
${format === "deb" ? `export DEBIAN_FRONTEND=noninteractive
apt-get update
# Satisfy Electron's trash dependency without pulling in a KDE desktop.
apt-get install -y --no-install-recommends trash-cli` : "dnf install -y --setopt=install_weak_deps=False util-linux"}
package="$1"
check() {
  # Fedora merges /usr/sbin into /usr/bin, so PATH may report either spelling.
  test "$(readlink -f "$(command -v mdbase)")" = /usr/lib/mdbase-connect/resources/mdbase
  test "$(readlink -f /usr/bin/mdbase)" = /usr/lib/mdbase-connect/resources/mdbase
  test "$(readlink -f /usr/bin/mdbase-connect)" = /usr/lib/mdbase-connect/mdbase-connect
  ${owner}
  # Exercise the CLI as an ordinary user, without starting a daemon or touching collections.
  su -s /bin/sh nobody -c 'mdbase --version && mdbase --help'
  test "$(mdbase --version)" = "$(/usr/lib/mdbase-connect/resources/mdbase --version)"
  test "$(mdbase --version)" = "$expected_version"
}
${install}
expected_version="$(mdbase --version)"
check
${reinstall}
check
${remove}
test ! -e /usr/bin/mdbase && test ! -L /usr/bin/mdbase
${previous ? `package="$2"
${install}
package="$1"
${install}
check
${remove}
test ! -e /usr/bin/mdbase && test ! -L /usr/bin/mdbase` : ""}
`;
  const result = spawnSync("docker", [
    "run", "--rm", ...mounts, image, "sh", "-c", script, "verify-linux-packages",
    `/packages/${basename(artifact)}`,
    ...(previous ? [`/previous/${basename(previous)}`] : [])
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${format} package verification failed (${result.status})`);
  console.log(`${format}: install, reinstall, ${previous ? "upgrade, " : ""}ownership, non-root CLI, and removal passed.`);
}
