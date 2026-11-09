import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/greader", () => ({
  authenticateGReaderPassword: vi.fn(),
  createGReaderToken: vi.fn(() => "token"),
}));
import { authenticateGReaderPassword } from "@/lib/greader";
import { POST } from "@/app/api/greader/accounts/ClientLogin/route";

const request = () => new Request("http://localhost/api/greader/accounts/ClientLogin", {
  method: "POST", body: new URLSearchParams({ Email: "user@example.org", Passwd: "password" }),
});
describe("ClientLogin errors", () => {
  it("keeps the authentication failure contract", async () => {
    vi.mocked(authenticateGReaderPassword).mockResolvedValueOnce(null);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Error=BadAuthentication\n");
  });
  it("returns 500 for server failures without disclosing details", async () => {
    vi.mocked(authenticateGReaderPassword).mockRejectedValueOnce(new Error("private database details"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });
});
