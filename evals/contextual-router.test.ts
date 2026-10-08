import { describe, expect, it } from "vitest";
import { groupBootstrapLowerBound, simultaneousGroupBootstrapLowerBounds } from "./contextual-router.js";

/** Deterministic pseudo-noise so fixtures do not depend on Math.random. */
function noisy(count: number, centre: number, spread: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const wave = Math.sin(index * 12.9898) * 43758.5453;
    return centre + (wave - Math.floor(wave) - 0.5) * spread;
  });
}

const groups = (count: number): string[] => Array.from({ length: count }, (_, index) => `group-${index}`);

describe("simultaneous group bootstrap bounds", () => {
  it("places every bound below its point estimate", () => {
    const deltas = [noisy(200, -0.01, 0.1), noisy(200, -0.02, 0.2)];
    const bounds = simultaneousGroupBootstrapLowerBounds(deltas, groups(200), 500, "fixed");
    bounds.forEach((bound, index) => {
      const pointEstimate = deltas[index]!.reduce((sum, value) => sum + value, 0) / deltas[index]!.length;
      expect(bound).toBeLessThan(pointEstimate);
    });
  });

  it("is more conservative than scoring one configuration in isolation", () => {
    const target = noisy(200, -0.01, 0.1);
    const alone = simultaneousGroupBootstrapLowerBounds([target], groups(200), 500, "fixed")[0]!;
    const amongMany = simultaneousGroupBootstrapLowerBounds(
      [target, ...Array.from({ length: 19 }, (_, index) => noisy(200, -0.01 * index, 0.15))],
      groups(200),
      500,
      "fixed",
    )[0]!;
    // Searching 20 configurations must cost the winner some of its guarantee.
    expect(amongMany).toBeLessThan(alone);
  });

  it("does not let one noisy configuration set the band for a precise one", () => {
    const precise = noisy(200, -0.01, 0.001);
    const withCalm = simultaneousGroupBootstrapLowerBounds(
      [precise, noisy(200, -0.01, 0.002)],
      groups(200),
      500,
      "fixed",
    )[0]!;
    const withWild = simultaneousGroupBootstrapLowerBounds(
      [precise, noisy(200, -0.3, 2)],
      groups(200),
      500,
      "fixed",
    )[0]!;
    // Studentising keeps the wild configuration's spread out of the precise
    // configuration's band; an unscaled max statistic would collapse this.
    expect(Math.abs(withWild - withCalm)).toBeLessThan(0.01);
  });

  it("agrees with the single-configuration bound to within sampling noise when alone", () => {
    const deltas = noisy(300, -0.01, 0.08);
    const single = groupBootstrapLowerBound(deltas, groups(300), 4_000, "fixed");
    const simultaneous = simultaneousGroupBootstrapLowerBounds([deltas], groups(300), 4_000, "fixed")[0]!;
    expect(Math.abs(simultaneous - single)).toBeLessThan(0.01);
  });

  it("is deterministic for a given seed and varies with it", () => {
    const deltas = [noisy(150, -0.01, 0.1)];
    const first = simultaneousGroupBootstrapLowerBounds(deltas, groups(150), 400, "seed-one")[0]!;
    const repeat = simultaneousGroupBootstrapLowerBounds(deltas, groups(150), 400, "seed-one")[0]!;
    const other = simultaneousGroupBootstrapLowerBounds(deltas, groups(150), 400, "seed-two")[0]!;
    expect(repeat).toBe(first);
    expect(other).not.toBe(first);
  });

  it("widens as the confidence level rises", () => {
    const deltas = [noisy(200, -0.01, 0.1)];
    const ninetyFive = simultaneousGroupBootstrapLowerBounds(deltas, groups(200), 800, "fixed", 0.05)[0]!;
    const ninetyNine = simultaneousGroupBootstrapLowerBounds(deltas, groups(200), 800, "fixed", 0.01)[0]!;
    expect(ninetyNine).toBeLessThan(ninetyFive);
  });

  it("keeps records in their prompt group when resampling", () => {
    // Two records per group, perfectly correlated inside it. Treating them as
    // independent would understate the spread and overstate the bound.
    const paired = [0, 1, 2, 3].flatMap((value) => [value, value]);
    const correlatedGroups = [0, 1, 2, 3].flatMap((index) => [`g${index}`, `g${index}`]);
    const bound = simultaneousGroupBootstrapLowerBounds([paired], correlatedGroups, 500, "fixed")[0]!;
    expect(Number.isFinite(bound)).toBe(true);
    expect(bound).toBeLessThan(1.5);
  });

  it("returns nothing for an empty configuration set", () => {
    expect(simultaneousGroupBootstrapLowerBounds([], groups(10), 100, "fixed")).toEqual([]);
  });

  it("rejects a configuration whose deltas do not line up with the records", () => {
    expect(() => simultaneousGroupBootstrapLowerBounds([[1, 2]], groups(3), 100, "fixed"))
      .toThrow(/one delta per validation record/);
  });
});
