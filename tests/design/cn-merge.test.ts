import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn() knows the design tokens", () => {
  it("keeps a type token next to a text colour", () => {
    for (const t of ["caption", "footnote", "body-sm", "body", "row-title", "title-sm", "title", "headline", "display"]) {
      expect(cn(`text-${t} text-foreground`)).toBe(`text-${t} text-foreground`);
      expect(cn(`text-foreground text-${t}`)).toBe(`text-foreground text-${t}`);
      expect(cn(`text-${t} text-muted-foreground`)).toBe(`text-${t} text-muted-foreground`);
    }
  });

  it("later type token / radius / elevation / blur / tracking wins over legacy siblings", () => {
    expect(cn("text-sm", "text-caption")).toBe("text-caption");
    expect(cn("text-display", "text-xl")).toBe("text-xl");
    expect(cn("rounded-xl", "rounded-sheet")).toBe("rounded-sheet");
    expect(cn("rounded-sheet", "rounded-md")).toBe("rounded-md");
    expect(cn("rounded-t-lg", "rounded-t-sheet")).toBe("rounded-t-sheet");
    expect(cn("shadow-lg", "shadow-overlay")).toBe("shadow-overlay");
    expect(cn("backdrop-blur-sm", "backdrop-blur-bar")).toBe("backdrop-blur-bar");
    expect(cn("tracking-tight", "tracking-title")).toBe("tracking-title");
  });

  it("does not merge independent groups", () => {
    expect(cn("text-caption font-semibold tracking-title rounded-row shadow-bar")).toBe(
      "text-caption font-semibold tracking-title rounded-row shadow-bar",
    );
    expect(cn("bg-warning/10 text-warning border-warning/20")).toBe("bg-warning/10 text-warning border-warning/20");
  });
});
