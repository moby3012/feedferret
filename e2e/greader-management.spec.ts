import { test, expect } from "./helpers/greader-test";

test("FreshRSS PHP aliases preserve POST credentials and repeated subscription fields", async ({ request }) => {
  const probe = await request.get("/api/greader.php");
  expect(await probe.text()).toBe("OK");
  const options = await request.fetch("/api/greader.php/reader/api/0/subscription/edit", { method: "OPTIONS" });
  expect(options.ok()).toBe(true);
  expect(options.headers().allow).toContain("POST");
  const login = await request.post("/api/greader.php/accounts/ClientLogin", {
    form: { Email: "e2e-desktop@feedferret.test", Passwd: "e2e-password-123" },
  });
  expect(login.status()).toBe(200);
  const token = (await login.text()).match(/Auth=(.+)/)![1];
  const headers = { Authorization: `GoogleLogin auth=${token}` };
  const list = await request.get("/api/greader.php/reader/api/0/subscription/list", { headers });
  const feeds = (await list.json()).subscriptions.slice(0, 2);
  expect(feeds).toHaveLength(2);
  const form = new URLSearchParams([["ac", "edit"], ["t", "Alias Ü"], ...feeds.map((f: { id: string }) => ["s", f.id] as [string, string])]);
  const edit = await request.post("/api/greader.php/reader/api/0/subscription/edit", {
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, data: form.toString(),
  });
  expect(await edit.text()).toBe("OK");
  const canonical = await request.get("/api/greader/reader/api/0/subscription/list", { headers });
  const edited = (await canonical.json()).subscriptions.filter((f: { id: string }) => feeds.some((original: { id: string }) => original.id === f.id));
  expect(edited.map((f: { title: string }) => f.title)).toEqual(["Alias Ü", "Alias Ü"]);
  expect((await request.get("/api/fever.php?api")).status()).toBe(200);
});
