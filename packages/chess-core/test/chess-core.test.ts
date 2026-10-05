import { describe, expect, it } from "vitest";
import { fixturePgn } from "../../../tests/fixtures";
import {
  START_FEN,
  bestCaptureGain,
  createsMateThreat,
  isFork,
  legalMoveCount,
  mateInOne,
  material,
  parseGame,
  parseMove,
  sourceGameIdFromUrl,
  staticExchange,
  terminalState,
  threatenedLoss,
  uciLineToMoves,
} from "../src";

describe("parseGame", () => {
  it("records ply, SAN, UCI and FENs for every move", () => {
    const g = parseGame(fixturePgn("mate-in-one"));
    expect(g.supported).toBe(true);
    expect(g.result).toBe("1-0");
    expect(g.moves).toHaveLength(7);
    expect(g.moves[0]).toMatchObject({ ply: 1, san: "e4", uci: "e2e4", fenBefore: START_FEN });
    expect(g.moves[6]!.san).toBe("Qxf7#");
    expect(g.moves[1]!.fenBefore).toBe(g.moves[0]!.fenAfter);
    expect(terminalState(g.moves[6]!.fenAfter)).toEqual({ kind: "checkmate", winner: "white" });
  });

  it("handles castling on both sides", () => {
    const g = parseGame(fixturePgn("castling"));
    expect(g.moves.find((m) => m.san === "O-O")?.uci).toBe("e1g1");
    expect(g.moves.find((m) => m.san === "O-O-O")?.uci).toBe("e8c8");
  });

  it("handles en passant", () => {
    const g = parseGame(fixturePgn("en-passant"));
    const ep = g.moves.at(-1)!;
    expect(ep.san).toBe("exd6");
    expect(ep.uci).toBe("e5d6");
    expect(material(ep.fenAfter).balance).toBe(1);
  });

  it("handles promotion from a set-up position", () => {
    const g = parseGame(fixturePgn("promotion"));
    expect(g.startFen).toBe("8/P7/8/8/8/8/k7/4K3 w - - 0 1");
    expect(g.moves[0]).toMatchObject({ san: "a8=Q+", uci: "a7a8q" });
  });

  it("detects stalemate and insufficient material", () => {
    expect(terminalState(parseGame(fixturePgn("stalemate")).moves.at(-1)!.fenAfter)).toEqual({
      kind: "stalemate",
      winner: null,
    });
    const ins = parseGame(fixturePgn("insufficient-material"));
    expect(ins.moves[0]!.ply).toBe(1);
    expect(terminalState(ins.moves.at(-1)!.fenAfter)?.kind).toBe("insufficient_material");
  });

  it("parses repetition games without error", () => {
    const g = parseGame(fixturePgn("repetition"));
    expect(g.moves).toHaveLength(8);
    expect(g.moves.at(-1)!.fenAfter.split(" ")[0]).toBe(START_FEN.split(" ")[0]);
  });

  it("marks Chess960 as unsupported without replaying it", () => {
    const g = parseGame(fixturePgn("chess960"));
    expect(g.supported).toBe(false);
    expect(g.variant).toBe("Chess960");
    expect(g.moves).toEqual([]);
  });

  it("rejects corrupt PGN", () => {
    expect(() => parseGame('[Event "x"]\n\n1. e4 e5 2. Ke3 Qxz9 *')).toThrow();
  });
});

describe("parseMove", () => {
  const afterNf3Nf6 = "rnbqkb1r/ppp1pppp/5n2/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 2 3";

  it("accepts SAN and UCI", () => {
    expect(parseMove(START_FEN, "e4")).toMatchObject({ ok: true, san: "e4", uci: "e2e4" });
    expect(parseMove(START_FEN, "g1f3")).toMatchObject({ ok: true, san: "Nf3" });
    expect(parseMove(START_FEN, "Nf3+")).toMatchObject({ ok: true, san: "Nf3" });
  });

  it("rejects ambiguous moves", () => {
    expect(parseMove(afterNf3Nf6, "Nd2")).toMatchObject({ ok: false, error: "ambiguous" });
    expect(parseMove(afterNf3Nf6, "Nbd2")).toMatchObject({ ok: true, uci: "b1d2" });
  });

  it("rejects illegal moves", () => {
    expect(parseMove(START_FEN, "e5")).toMatchObject({ ok: false, error: "illegal" });
    expect(parseMove(START_FEN, "e2e5")).toMatchObject({ ok: false, error: "illegal" });
    expect(parseMove(START_FEN, "Kh1")).toMatchObject({ ok: false, error: "illegal" });
  });

  it("requires a promotion piece in UCI", () => {
    expect(parseMove("8/P7/8/8/8/8/k7/4K3 w - - 0 1", "a7a8")).toMatchObject({ ok: false, error: "ambiguous" });
    expect(parseMove("8/P7/8/8/8/8/k7/4K3 w - - 0 1", "a8=N")).toMatchObject({ ok: true, uci: "a7a8n" });
  });
});

describe("tactics", () => {
  it("sees that a queen can be won", () => {
    const g = parseGame(fixturePgn("hanging-queen"));
    const beforeNxh4 = g.moves[4]!.fenBefore; // after 2...Qh4
    expect(bestCaptureGain(beforeNxh4).gain).toBe(9);
    expect(threatenedLoss(beforeNxh4, "black").loss).toBe(9);
    expect(staticExchange(beforeNxh4, { from: "f3", to: "h4" })).toBe(9);
  });

  it("values an undefended piece move as losing material", () => {
    // After 1.e4 e5: Bc4 is safe, Ba6 drops the bishop to bxa6/Nxa6.
    const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    expect(staticExchange(fen, { from: "f1", to: "c4" })).toBe(0);
    expect(staticExchange(fen, { from: "f1", to: "a6" })).toBe(-3);
  });

  it("finds mate in one and mate threats", () => {
    const g = parseGame(fixturePgn("missed-mate"));
    const beforeQf3 = g.moves.at(-1)!.fenBefore;
    expect(mateInOne(beforeQf3)?.san).toBe("Qxf7#");
    expect(createsMateThreat(g.moves[4]!.fenAfter)).toBe(true); // 3.Bc4 threatens Qxf7#
  });

  it("detects a knight fork", () => {
    // White knight on c7 forks king e8 and rook a8.
    expect(isFork("r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1", "c7")).toBe(true);
    expect(isFork("4k3/2N5/8/8/8/8/8/4K3 b - - 0 1", "c7")).toBe(false);
  });

  it("counts legal moves for forced-move detection", () => {
    const g = parseGame(fixturePgn("forced-move"));
    expect(legalMoveCount(g.moves.at(-1)!.fenBefore)).toBe(1);
  });

  it("converts UCI lines to SAN and stops at illegal moves", () => {
    const moves = uciLineToMoves(START_FEN, ["e2e4", "e7e5", "g1f3", "a1a8"]);
    expect(moves.map((m) => m.san)).toEqual(["e4", "e5", "Nf3"]);
  });
});

describe("sourceGameIdFromUrl", () => {
  it("extracts live and daily ids", () => {
    expect(sourceGameIdFromUrl("https://www.chess.com/game/live/148327001")).toBe("live/148327001");
    expect(sourceGameIdFromUrl("https://www.chess.com/game/daily/5551")).toBe("daily/5551");
  });
});
