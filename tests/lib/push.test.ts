import { afterEach, beforeEach, expect, it, vi } from "vitest";
import https from "node:https";
import type { LookupFunction } from "node:net";
const mocks = vi.hoisted(() => ({ send: vi.fn(), subscriptions: vi.fn(), lookup: vi.fn(), update: vi.fn() }));
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: mocks.send } }));
vi.mock("@/lib/db", () => ({ db: { pushSubscription: { findMany: mocks.subscriptions, update: mocks.update } } }));
vi.mock("dns/promises", () => ({ default: { lookup: async () => [{ address: "8.8.8.8", family: 4 }] } }));
vi.mock("node:dns", () => ({ default: { lookup: mocks.lookup } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { sendPushToUser } from "../../lib/push";
import { safeLookup } from "../../lib/safe-dispatcher";
beforeEach(() => {
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", "test");
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", "test");
  vi.stubEnv("WEB_PUSH_CONTACT", "mailto:test@example.com");
  mocks.send.mockReset(); mocks.lookup.mockReset(); mocks.update.mockResolvedValue({});
  mocks.subscriptions.mockResolvedValue([{ id: "push", endpoint: "https://rebind.test/push", p256dh: "test", auth: "test" }]);
});
afterEach(() => vi.unstubAllEnvs());
it("passes a shared pinned HTTPS agent and the 10s timeout to web-push", async () => {
  mocks.send.mockResolvedValue({});
  await sendPushToUser("u", { title: "test" });
  await sendPushToUser("u", { title: "test again" });
  const options = mocks.send.mock.calls[0][2];
  expect(options.timeout).toBe(10_000);
  expect(options.agent).toBeInstanceOf(https.Agent);
  expect(options.agent.options).toMatchObject({ lookup: safeLookup, keepAlive: true });
  expect(mocks.send.mock.calls[1][2].agent).toBe(options.agent);
});
it("rejects public preflight → private socket DNS on push delivery", async () => {
  mocks.lookup.mockImplementation((_hostname, _opts, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]));
  mocks.send.mockImplementation((_subscription, _body, options) => new Promise((resolve, reject) => {
    const lookup = options.agent.options.lookup as LookupFunction;
    lookup("rebind.test", {}, (error, address) => error ? reject(error) : resolve(address));
  }));
  expect(await sendPushToUser("u", { title: "test" })).toMatchObject({ sent: 0, failed: 1 });
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
});
it("blocks private IP literals before web-push (lookup would not run)", async () => {
  mocks.subscriptions.mockResolvedValue([{ id: "push", endpoint: "https://169.254.169.254/push", p256dh: "test", auth: "test" }]);
  expect(await sendPushToUser("u", { title: "test" })).toMatchObject({ sent: 0, failed: 1 });
  expect(mocks.send).not.toHaveBeenCalled();
});
it("continues the batch after a hanging endpoint exceeds the total deadline", async () => {
  vi.useFakeTimers();
  try {
    mocks.subscriptions.mockResolvedValue([
      { id: "one", endpoint: "https://rebind.test/push", p256dh: "test", auth: "test" },
      { id: "two", endpoint: "https://rebind.test/push", p256dh: "test", auth: "test" },
    ]);
    mocks.send.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({});
    const pending = sendPushToUser("u", { title: "test" });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({ sent: 1, failed: 1 });
  } finally { vi.useRealTimers(); }
});
