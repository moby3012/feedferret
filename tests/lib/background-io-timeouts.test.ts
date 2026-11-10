// Outbound I/O used by background jobs must carry timeouts (a tarpit push endpoint or silent SMTP
// server would otherwise hold a job -- and its caller -- for minutes or forever).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  sendNotification: vi.fn(async () => ({ statusCode: 201 })),
  createTransport: vi.fn(),
  sendMail: vi.fn(async () => ({})),
  subscriptions: [{ id: "s1", endpoint: "https://push.example/1", p256dh: "p", auth: "a" }],
}));

vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: m.sendNotification } }));
vi.mock("nodemailer", () => ({ default: { createTransport: (...args: unknown[]) => (m.createTransport(...args), { sendMail: m.sendMail }) } }));
vi.mock("@/lib/db", () => ({
  db: {
    pushSubscription: { findMany: vi.fn(async () => m.subscriptions), update: vi.fn(async () => ({})) },
    globalSettings: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/system-log", () => ({ writeSystemLog: vi.fn(async () => undefined) }));
vi.mock("@/lib/crypto", () => ({ decryptIfValue: (v: string | null) => v }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "pub";
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "priv";
  process.env.WEB_PUSH_CONTACT = "mailto:test@example.org";
});

describe("background I/O timeouts", () => {
  it("web-push requests carry a request timeout", async () => {
    const { sendPushToUser } = await import("@/lib/push");
    await sendPushToUser("u", { title: "t", body: "b" } as never);
    expect(m.sendNotification).toHaveBeenCalledTimes(1);
    const options = (m.sendNotification.mock.calls[0] as unknown[])[2] as { timeout?: number };
    expect(options.timeout).toBe(10_000);
  });

  it("SMTP transports get connection / greeting / socket timeouts", async () => {
    const { sendSystemEmail } = await import("@/lib/mail");
    await sendSystemEmail({
      to: "a@example.org", subject: "s", html: "<p>x</p>", text: "x",
      overrideSettings: { mailServiceEnabled: true, smtpHost: "smtp.example.org", smtpPort: 587, smtpFrom: "f@example.org" } as never,
    });
    expect(m.createTransport).toHaveBeenCalledTimes(1);
    expect(m.createTransport.mock.calls[0][0]).toMatchObject({ connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 30_000 });
  });
});
