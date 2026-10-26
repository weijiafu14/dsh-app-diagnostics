import { DeviceAgent } from "../dist/device.js";
const agent = new DeviceAgent(JSON.parse(process.env.DIAGNOSTIC_TEST_CONFIG), {
  snapshot: () => ({ role: "fixture" }),
  prepareDebug: () => ({ running: true }),
  finishDebug: () => {
    process.send?.({ type: "restored" });
  },
});
agent.on("ready", (x) => process.send?.(x));
agent.on("fault", (x) => process.send?.({ type: "fault", ...x }));
agent.start();
globalThis.diagnosticFixture = { counter: 0 };
setInterval(() => globalThis.diagnosticFixture.counter++, 30).unref();
process.on("message", async (m) => {
  if (m === "stop") {
    await agent.stop();
    process.exit(0);
  }
});
