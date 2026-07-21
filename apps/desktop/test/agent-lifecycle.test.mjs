import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import lifecycle from "../dist/main/agent-lifecycle.js";

const { relaunchAfterAgentStops } = lifecycle;

test("the agent exits before the desktop application relaunches", async () => {
  const events = [];
  const agent = new EventEmitter();
  agent.exitCode = null;
  agent.signalCode = null;
  agent.kill = () => {
    events.push("terminate-agent");
    setTimeout(() => {
      agent.signalCode = "SIGTERM";
      events.push("agent-exited");
      agent.emit("exit", null, "SIGTERM");
    }, 10);
    return true;
  };

  await relaunchAfterAgentStops(
    agent,
    () => events.push("relaunch-app"),
    () => events.push("exit-app")
  );

  assert.deepEqual(events, [
    "terminate-agent",
    "agent-exited",
    "relaunch-app",
    "exit-app"
  ]);
});
