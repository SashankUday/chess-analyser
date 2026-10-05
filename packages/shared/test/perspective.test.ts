import { describe, expect, it } from "vitest";
import { moverCp, moverWinPercent, resultClass, winPercentFromCp, type NormalisedEvaluation } from "../src";

const cp = (whiteCp: number): NormalisedEvaluation => ({ whiteCp, mateForWhiteIn: null });
const mate = (n: number): NormalisedEvaluation => ({ whiteCp: null, mateForWhiteIn: n });
const change = (from: number, to: number, mover: "white" | "black") =>
  moverWinPercent(cp(to), mover) - moverWinPercent(cp(from), mover);

describe("mover perspective (V2 plan §2–3)", () => {
  it("White +3.7 → +7.8 is an improvement for White", () => {
    expect(change(370, 780, "white")).toBeGreaterThan(0);
  });

  it("White +3.7 → +7.8 is a major deterioration for Black", () => {
    expect(moverCp(cp(370), "black")).toBe(-370);
    expect(moverCp(cp(780), "black")).toBe(-780);
    expect(change(370, 780, "black")).toBeLessThan(-10);
  });

  it("-2 → +1 improves White and worsens Black", () => {
    expect(change(-200, 100, "white")).toBeGreaterThan(0);
    expect(change(-200, 100, "black")).toBeLessThan(0);
  });

  it("maps mate to the extremes for the right side", () => {
    expect(moverWinPercent(mate(3), "white")).toBe(100);
    expect(moverWinPercent(mate(3), "black")).toBe(0);
    expect(moverWinPercent(mate(-2), "black")).toBe(100);
    expect(moverCp(mate(-2), "black")).toBeGreaterThan(9000);
    expect(resultClass(mate(-2), "white")).toBe("FORCED_LOSS");
  });

  it("implements the Lichess winning-chances formula", () => {
    expect(winPercentFromCp(0)).toBe(50);
    expect(winPercentFromCp(370)).toBeCloseTo(79.6, 1);
    expect(winPercentFromCp(-370)).toBeCloseTo(20.4, 1);
    expect(winPercentFromCp(5000)).toBe(winPercentFromCp(1000));
  });

  it("classifies coarse results from the mover's point of view", () => {
    expect(resultClass(cp(0), "white")).toBe("EQUAL");
    expect(resultClass(cp(780), "white")).toBe("WINNING");
    expect(resultClass(cp(780), "black")).toBe("LOSING");
    expect(resultClass(cp(370), "black")).toBe("DISADVANTAGE");
  });
});
