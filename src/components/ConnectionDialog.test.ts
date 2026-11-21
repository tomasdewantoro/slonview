import { describe, expect, it } from "vitest";
import { PROFILE_COLORS, profileColor } from "./ConnectionDialog";

describe("profile colours", () => {
  it("never offers red (red is reserved for WRITE and errors)", () => {
    expect(PROFILE_COLORS).not.toContain("#e5484d");
  });

  it("renders the retired red as the nearest remaining colour", () => {
    expect(profileColor("#e5484d")).toBe("#f59e0b");
    expect(profileColor("#E5484D")).toBe("#f59e0b");
    expect(PROFILE_COLORS).toContain(profileColor("#e5484d"));
  });

  it("passes other colours and null through", () => {
    expect(profileColor("#3b82f6")).toBe("#3b82f6");
    expect(profileColor(null)).toBeNull();
  });
});
