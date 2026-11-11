import { beforeEach, expect, it, vi } from "vitest";
const consume = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email-change", () => ({ consumeEmailChange: consume }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
import { submitEmailChange } from "@/app/account/confirm-email/actions";
beforeEach(() => { consume.mockReset(); });
it("reads the token and intent from posted fields", async () => {
  consume.mockResolvedValue("cancelled");
  const form = new FormData(); form.set("token", "token-from-form"); form.set("intent", "cancel");
  await expect(submitEmailChange(form)).rejects.toThrow("result=cancelled");
  expect(consume).toHaveBeenCalledWith("token-from-form", true);
});
it.each(["emailTaken", "invalid", "exception"])("shows invalid/expired for %s", async outcome => {
  if (outcome === "exception") consume.mockRejectedValue(new Error("database unavailable"));
  else consume.mockResolvedValue(outcome);
  const form = new FormData(); form.set("token", "t"); form.set("intent", "confirm");
  await expect(submitEmailChange(form)).rejects.toThrow("result=invalid");
});
it("rejects missing or invalid form fields", async () => {
  await expect(submitEmailChange(new FormData())).rejects.toThrow("result=invalid");
  expect(consume).not.toHaveBeenCalled();
});
