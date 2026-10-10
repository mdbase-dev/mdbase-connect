// The e2e scenarios, shared by the desktop and Android drivers. A platform supplies:
//   start() -> cdp client (app launched, plugin loaded)
//   stop()          graceful quit
//   kill()          hard kill (kill -9 / am force-stop)
//   outsideWrite(rel, text), outsideMove(fromRel, toRel)   a separate process changing the vault
import { suite } from "./cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAll(p, { kills = 5, journalN = 100, skip = [] } = {}) {
  const out = {};
  const log = (k, v) => {
    out[k] = v;
    console.log(k, JSON.stringify(v, (key, val) => (key === "env" ? undefined : val)).slice(0, 700));
  };
  let c = await p.start();
  try {
    log("env", (await suite(c, "shared")).env);
    log("shared", (await suite(c, "shared")).result);
    log("journal", (await suite(c, "journal", { n: journalN })).result);
    log("vault", (await suite(c, "vault")).result);
    log("keysSave", (await suite(c, "keys", { phase: "save" })).result);
    log("index", (await suite(c, "index", { n: 10000, wipe: true })).result);
    log("indexSecondOpener", (await suite(c, "indexSecondOpener")).result);

    await p.outsideWrite("e2e-move/a/note.md", "moved by an outside tool\n");
    await sleep(2500);
    await suite(c, "vaultEventsStart");
    await p.outsideMove("e2e-move/a/note.md", "e2e-move/b/note.md");
    await sleep(3000);
    log("outsideMove", (await suite(c, "vaultEventsCollect")).result);

    if (!skip.includes("fence")) {
      for (const mode of ["fence", "naive"]) {
        const path = `fence-${mode}.md`;
        await suite(c, "fenceOpen", { path });
        await c.send("Page.bringToFront").catch(() => {});
        // Type every 80 ms for 20 s while publishing every 250 ms.
        let typed = 0;
        const typingEnds = Date.now() + 20000;
        const typer = (async () => {
          while (Date.now() < typingEnds) {
            await c.send("Input.insertText", { text: `t${typed} ` });
            typed++;
            await sleep(80);
          }
        })();
        const watch = suite(c, "fenceWatch", { path, ms: 23500 });
        const stress = await suite(c, "fenceStress", { path, ms: 20000, mode });
        await typer;
        const w = await watch;
        const disk = stress.result.disk;
        let lost = 0;
        for (let i = 0; i < typed; i++) if (!disk.includes(`t${i} `)) lost++;
        log(`fence_${mode}`, {
          typed,
          lostKeystrokes: lost,
          published: stress.result.published,
          finalCounter: stress.result.finalCounter,
          finalCorrect: stress.result.finalCounter === stress.result.published,
          results: stress.result.results,
          diskRegressions: w.result.regressions,
          p50ms: stress.result.p50,
        });
      }
    }

    await suite(c, "indexClose");
    c.close();
    await p.stop();
    c = await p.start();
    log("restartKeys", (await suite(c, "keys", { phase: "load" })).result);
    log("restartIndex", (await suite(c, "index", { n: 10000 })).result);
    await suite(c, "indexClose");

    const trials = [];
    for (let k = 0; k < kills; k++) {
      await suite(c, "index", { n: 10000 });
      let maxAck = 0;
      const off = c.on((m) => {
        if (m.method === "Runtime.consoleAPICalled") {
          const a = m.params.args.map((x) => x.value);
          if (a[0] === "MDB-ACK" && a[1] === "journal") maxAck = Math.max(maxAck, a[2]);
        }
      });
      await c.send("Runtime.enable");
      await suite(c, "journalCrashStart");
      await sleep(1500 + Math.random() * 4500);
      await p.kill();
      off();
      c.close();
      c = await p.start();
      const v = (await suite(c, "journalCrashVerify")).result;
      const idx = (await suite(c, "index", { n: 10000 })).result;
      await suite(c, "indexClose");
      const t = { maxAck, recovered: v.seq, lost: Math.max(0, maxAck - v.seq), gaps: v.gaps, copies: v.report?.copies?.map((x) => `${x.name}:${x.state}`), indexOpened: idx.info.opened, indexRows: idx.openCount };
      trials.push(t);
      console.log("kill", k, JSON.stringify(t));
    }
    log("kills", { trials: trials.length, acked: trials.reduce((s, x) => s + x.maxAck, 0), lostAcked: trials.reduce((s, x) => s + x.lost, 0), trialsLosing: trials.filter((x) => x.lost > 0).length, detail: trials });
  } catch (e) {
    log("error", String(e?.stack ?? e).slice(0, 3000));
  } finally {
    c.close();
    await p.stop();
  }
  return out;
}
