"""Exercise the guided Unix CLI in a temporary home. --chromium also redeems the
code with a pinned WebTransport client; run that option in a loopback-only network
namespace with Node, @playwright/test and its Chromium (or CHROME_BIN). The
existing webtransport-net-fixture.sh also exercises the private interface and QR.
"""

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import socket
import sqlite3
import subprocess
import tempfile
import time
from urllib.parse import unquote, urlsplit


SITE = "https://third-party.invalid"
OTHER = "https://another.invalid"
SITES = "[q]uit?"
MENU = "Browser access: [p]air, [l]ist, or [r]evoke?"
LABEL = "New browser label"
PHONE = "Téléphone"
CODE = "Enter this one-time code in that app:"


class Terminal:
    def __init__(self, master):
        self.master = master
        self.buffer = b""

    def expect(self, marker):
        marker = marker.encode()
        deadline = time.monotonic() + 15
        while marker not in self.buffer:
            if not select.select([self.master], [], [], max(0, deadline - time.monotonic()))[0]:
                raise TimeoutError(f"guided CLI did not reach {marker!r}")
            chunk = os.read(self.master, 16384)
            if not chunk or len(self.buffer) + len(chunk) > 65536:
                raise AssertionError("unexpected end or size of terminal output")
            self.buffer += chunk
        consumed, self.buffer = self.buffer.split(marker, 1)
        return consumed.decode()

    def send(self, line):
        os.write(self.master, line.encode() + b"\n")

    def answer(self, marker, line):
        before = self.expect(marker)
        self.send(line)
        return before

    def stop(self):
        os.write(self.master, b"\x04")


@contextmanager
def terminal(binary, home, folder, expected_exit=0):
    master, slave = pty.openpty()
    process = subprocess.Popen(
        [binary, "pair-app", folder], stdin=slave, stdout=slave, stderr=slave,
        env={**os.environ, "HOME": str(home), "MDBASE_HOME": str(home)},
    )
    os.close(slave)
    try:
        yield Terminal(master)
        assert process.wait(10) == expected_exit
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


def check_folder(binary, home, folder):
    def refused(reason):
        with terminal(binary, home, folder, expected_exit=1) as cli:
            output = cli.expect(reason)
            assert "mdbase pair-app:" in output and "Trusted HTTPS" not in output

    refused("No mdbase.yaml")
    private = folder / ".mdbase"
    private.mkdir()
    descriptor = private / "host.json"
    with (private / "host.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        refused("holds this collection's host lock")
        descriptor.write_text(json.dumps({"host": "daemon", "since_ms": 0, "heartbeat_ms": 0}))
        refused("already hosted by the mdbase daemon")
    descriptor.write_text(json.dumps({"host": "obsidian", "since_ms": 0, "heartbeat_ms": 0}))
    refused("already hosted by Obsidian")
    descriptor.write_text("?")
    refused("Cannot verify this folder's host descriptor")
    descriptor.unlink()


def add_site(cli, site, confirm="yes"):
    cli.answer(SITES, "add")
    cli.answer("origin (Enter cancels):", site)
    cli.answer(f"Trust {site} to read and write this collection through a paired browser? [y/N]", confirm)


def select_network(cli, consent, private=False):
    cli.answer(SITES, "")
    interfaces = cli.answer("Network [1]:", "LAN")
    if private:
        assert '2. Private network "wt-host" (192.168.88.1)' in interfaces
    assert "select a number" in cli.answer("Network [1]:", "2" if private else "")
    summary = cli.answer("Start serving? [y/N]", "maybe")
    address = "192.168.88.1" if private else "127.0.0.1"
    assert SITE in summary and f"{address}:14918" in summary
    assert "Enter yes or no" in cli.answer("Start serving? [y/N]", consent)


def start_pair(cli, label=PHONE):
    cli.answer(MENU, "PAIR")
    cli.answer("App number (Enter cancels):", "0")
    cli.answer("App number (Enter cancels):", "1")
    cli.answer(LABEL, label)


def invitation(cli, expected_origin, private=False):
    output = cli.expect(CODE)
    assert ("\x1b[30;47m" in output) == private
    assert ("selected private network" if private else "THIS computer") in output
    link = re.search(r"https://[^\s]+/#mdbase-pair=[^\s]+", output).group()
    parsed = urlsplit(link)
    assert (f"{parsed.scheme}://{parsed.netloc}", parsed.path, parsed.query) == (expected_origin, "/", "")
    host = "192.168.88.1" if private else "127.0.0.1"
    assert re.fullmatch(rf"mdbase-pair=https://{re.escape(host)}:14918#sha256=[0-9a-f]{{64}}", unquote(parsed.fragment))
    code = cli.expect("(expires in three minutes)").strip()
    assert re.fullmatch(r"[0-9]{8}", code)
    return link, code


def redeem_in_browser(link, code, private=False):
    # The synthetic site only exists through route interception. The browser
    # receives the invitation and codes via stdin, never argv, URLs or logs.
    expected = {"lo", "wt-host"} if private else {"lo"}
    assert {name for _, name in socket.if_nameindex()} == expected, "use the isolated network fixture"
    client = r"""
const { chromium } = require('@playwright/test');
(async () => {
  const [link, code, permissionName] = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  const site = new URL(link).origin;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.send('Browser.setPermission', { permission: { name: permissionName }, setting: 'granted',
        origin: site, browserContextId: targetInfo.browserContextId });
    await page.route(site + '/', route => route.fulfill({contentType: 'text/html', body: '<!doctype html>'}));
    await page.goto(link);
    await page.evaluate(async ([code, permissionName]) => {
      const permission = await navigator.permissions.query({ name: permissionName });
      if (permission.state !== 'granted') throw Error('missing fixture network permission');
      const descriptor = new URLSearchParams(location.hash.slice(1)).get('mdbase-pair');
      const [endpoint, digest] = descriptor.split('#sha256=');
      const hash = Uint8Array.from(digest.match(/../g), octet => parseInt(octet, 16));
      for (const [candidate, valid] of [[code === '00000000' ? '00000001' : '00000000', false], [code, true]]) {
        const transport = new WebTransport(endpoint + '/_mdbase/pair', {serverCertificateHashes: [{algorithm: 'sha-256', value: hash}]});
        await transport.ready;
        const stream = await transport.createBidirectionalStream();
        await stream.writable.getWriter().write(new Uint8Array([0, 0, 0, 8, ...new TextEncoder().encode(candidate)]));
        if (valid) {
          const reply = new Uint8Array(await new Response(stream.readable).arrayBuffer());
          if (new DataView(reply.buffer).getUint32(0) !== reply.length - 4 ||
              new TextDecoder().decode(reply.slice(4, 9)) !== 'WTP1.') throw Error('missing grant');
          transport.close();
        } else if ((await transport.closed).closeCode !== 1008) {
          throw Error('expected pairing refusal');
        }
      }
    }, [code, permissionName]);
  } finally { await browser.close(); }
})().catch(error => { console.error('Chromium pairing fixture failed (' + error.name + ')'); process.exitCode = 1; });
"""
    subprocess.run(["node", "-e", client], input=json.dumps([link, code, "local-network" if private else "loopback-network"]), text=True,
                   cwd=Path(__file__).resolve().parent, check=True, timeout=30)


def run(binary, browser):
    private = bool(os.environ.get("WT_BROWSER_PEER"))
    if private:
        assert browser and {name for _, name in socket.if_nameindex()} == {"lo", "wt-host"}
    with tempfile.TemporaryDirectory() as temporary:
        home = Path(temporary)
        folder = home / "notes"
        folder.mkdir()
        check_folder(binary, home, folder)
        (folder / "mdbase.yaml").write_text('spec_version: "0.3.0"\n')
        with terminal(binary, home, folder) as cli:
            add_site(cli, SITE)
            select_network(cli, "NO")
            cli.expect("Serving cancelled.")
        assert not (home / ".mdbase-pairing").exists()

        with terminal(binary, home, folder) as cli:
            add_site(cli, "https://typo.invalid", confirm="n")
            cli.answer(SITES, "A")
            for invalid in ["site.invalid", "http://site.invalid", SITE + "/path", "https://*.invalid"]:
                cli.answer("origin (Enter cancels):", invalid)
                cli.expect("Use one exact HTTPS origin")
            cli.answer("origin (Enter cancels):", SITE + "/")
            cli.answer("paired browser? [y/N]", "YES")
            add_site(cli, OTHER)
            select_network(cli, "yes", private)
            startup = cli.expect(MENU)
            assert "Certificate SHA-256:" not in startup and "App invitation:" not in startup
            cli.send("bad menu")
            start_pair(cli, "é" * 41)
            cli.expect("80 UTF-8 bytes")
            cli.answer(LABEL, PHONE)
            link, code = invitation(cli, SITE, private)
            cli.answer(MENU, "list")
            cli.answer("App number (Enter cancels):", "1")
            cli.expect(f'Waiting for "{PHONE}". Attempts left: 5.')
            cli.expect("No paired browsers")
            if browser:
                redeem_in_browser(link, code, private)
                feedback = cli.expect(f'Paired "{PHONE}" at {SITE}.')
                assert "Attempts left: 4." in feedback and code not in feedback and "WTP1." not in feedback
                cli.send("pair")
                cli.answer("App number (Enter cancels):", "1")
                cli.answer(LABEL, PHONE)
                cli.expect("revoke the old browser first")
                cli.answer(LABEL, "")
                for consent in ["no", "yes"]:
                    cli.answer(MENU, "Revoke")
                    cli.answer("App number (Enter cancels):", "1")
                    choices = cli.answer("Browser number to revoke (Enter cancels):", "1")
                    assert PHONE in choices
                    cli.answer(f'Revoke "{PHONE}" at {SITE}, including its open sessions? [y/N]', consent)
                cli.expect(f'Revoked "{PHONE}" at {SITE}.')
                start_pair(cli)
                _, code = invitation(cli, SITE, private)
                redeem_in_browser(link, code, private)
                cli.expect(f'Paired "{PHONE}" at {SITE}.')
                cli.send("pair")
                cli.answer("App number (Enter cancels):", "1")
                cli.answer(LABEL, "Next browser")
                invitation(cli, SITE, private)
            cli.stop()

        with terminal(binary, home, folder) as cli:
            saved = cli.answer(SITES, "remove")
            assert f"1. {OTHER}" in saved and f"2. {SITE}" in saved and "typo.invalid" not in saved
            cli.answer("Site number to remove (Enter cancels):", "2")
            cli.answer(f"Remove {SITE} now and revoke ALL its browsers and its code? [y/N]", "yes")
            cli.answer(SITES, "quit")
        # A confirmed site removal persists even if the operator quits setup.
        database, = (home / ".mdbase-pairing").glob("*/credentials.sqlite")
        with sqlite3.connect(database) as db:
            assert db.execute("SELECT origin FROM allowed").fetchall() == [(OTHER,)]
            for table in ("pairing", "browser"):
                assert db.execute(f"SELECT count(*) FROM {table} WHERE origin=?", (SITE,)).fetchone() == (0,)
        with terminal(binary, home, folder) as cli:
            cli.answer(SITES, "remove")
            cli.answer("Site number to remove (Enter cancels):", "1")
            cli.answer("browsers and its code? [y/N]", "y")
            listing = cli.answer(SITES, "quit")
            assert "None selected" in listing


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--chromium", action="store_true")
    args = parser.parse_args()
    run(args.binary.resolve(strict=True), args.chromium)
    print("PASS: folder and locks, exact sites, consent, retries, link and QR policy, pending status, EOF and removal")
    if args.chromium:
        print("PASS: pinned Chromium redemption, bounded host feedback, Unicode label collision, revoke and re-pair")
