import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

async function lint(code: string) {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, "eslint.config.mjs") });
  const [res] = await eslint.lintText(code, { filePath: path.join(root, "components/__guard_probe__.tsx") });
  return res.messages.filter((m) => m.ruleId === "ff/no-raw-design-values");
}

describe("design-token lint guard", () => {
  it.each([
    ["rounded-[2rem]", '<div className="rounded-[2rem]" />'],
    ["rounded-t-[1.5rem]", '<div className="rounded-t-[1.5rem]" />'],
    ["z-[60]", '<div className="fixed z-[60]" />'],
    ["z-50", '<div className="fixed focus:z-50" />'],
    ["text-[10px]", '<span className="text-[10px]" />'],
    ["tracking-[-0.02em]", '<span className="tracking-[-0.02em]" />'],
    ["bg-amber-500/10", '<div className="bg-amber-500/10" />'],
    ["text-red-400", '<div className={`text-red-400 ${x}`} />'],
    ["backdrop-blur-xl", '<div className="backdrop-blur-xl" />'],
    ["backdrop-blur", '<div className="backdrop-blur" />'],
    ["env(safe-area-inset-top)", '<div className="pt-[env(safe-area-inset-top)]" />'],
    ["duration-500", '<div className="duration-500" />'],
    ["zIndex literal", "const s = { zIndex: 50 };"],
  ])("rejects %s", async (_name, code) => {
    expect((await lint(code)).length).toBeGreaterThan(0);
  });

  it.each([
    '<div className="rounded-sheet rounded-t-sheet rounded-full rounded-xl" />',
    '<div className="z-(--z-overlay) focus:z-(--z-skip)" />',
    '<span className="text-caption text-body-sm tracking-title text-[var(--x)]" />',
    '<div className="bg-warning/10 text-danger border-success/20 text-info bg-surface-bar" />',
    '<div className="backdrop-blur-bar backdrop-blur-overlay shadow-overlay" />',
    '<div className="pt-(--safe-t) duration-(--dur-base)" />',
    'const s = { zIndex: "var(--z-overlay)" };',
  ])("accepts %s", async (code) => {
    expect(await lint(code)).toEqual([]);
  });
});
