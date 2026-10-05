// Position intelligence (V2 plan §25–30). Only high-confidence facts are reported: exact chess-core
// tactics, and engine-verified mates found by searching the "if it were their move" position.
import {
  captureMoves,
  checkedKingSquare,
  checkingMoves,
  fenWithSideToMove,
  hangingPieces,
  immediateThreats,
  mateInOne,
  materialSequence,
  sideToMove,
  PIECE_NAMES,
} from "@chessanalyser/chess-core";
import {
  THREAT_SEARCH,
  moverMate,
  moverWinPercent,
  opposite,
  type Colour,
  type EngineAnalysis,
  type ForcedMaterialSequence,
  type MateThreat,
  type PositionInsights,
  type Threat,
} from "@chessanalyser/shared";

export interface InsightOptions {
  /** Root analysis of this position (best play for the side to move). */
  root: EngineAnalysis | null;
  /** Engine search of the position with the other side to move, for mate threats. */
  probe?: (fen: string) => Promise<EngineAnalysis | null>;
  /** Game ply of this position (for line numbering). */
  ply: number;
}

export async function positionInsights(fen: string, opts: InsightOptions): Promise<PositionInsights> {
  const stm = sideToMove(fen);
  const other = opposite(stm);
  const inCheck = checkedKingSquare(fen) !== null;

  const threats: Threat[] = immediateThreats(fen, other, THREAT_SEARCH.materialThreshold).map((t) => ({
    kind: t.kind,
    side: other,
    san: t.san,
    uci: t.uci,
    description: t.description,
    value: t.value,
    confidence: t.kind === "fork" ? "medium" : "high",
  }));

  const mateThreat = await findMateThreat(fen, other, opts.probe);
  if (mateThreat) {
    threats.unshift({
      kind: "mate",
      side: other,
      san: mateThreat.firstMove,
      uci: mateThreat.firstMoveUci,
      description: mateThreat.mateIn === 1 ? `${mateThreat.firstMove} is mate` : `mate in ${mateThreat.mateIn} starting with ${mateThreat.firstMove}`,
      confidence: "forced",
    });
  }

  const root = opts.root;
  let forcedMaterialGain: ForcedMaterialSequence | undefined;
  let forcedMaterialLoss: ForcedMaterialSequence | undefined;
  const best = root?.lines[0];
  if (best) {
    const seq = materialSequence(fen, best.moves, stm);
    if (seq && Math.abs(seq.net) >= 1) {
      const loser = seq.net > 0 ? other : stm;
      const entry: ForcedMaterialSequence = {
        side: seq.net > 0 ? stm : other,
        amount: Math.abs(seq.net),
        description: materialSequence(fen, best.moves, loser)?.description ?? "material",
        plies: seq.plies,
        immediate: seq.plies <= 2,
        line: best.moves.slice(0, Math.max(seq.plies, 2)).map((m) => m.san),
        lineId: best.id,
        firstPly: opts.ply + 1,
      };
      if (seq.net > 0) forcedMaterialGain = entry;
      else forcedMaterialLoss = entry;
    }
  }

  const criticality =
    root && root.lines.length >= 2
      ? Math.round((moverWinPercent(root.lines[0]!.evaluation, stm) - moverWinPercent(root.lines[1]!.evaluation, stm)) * 100) / 100
      : null;

  return {
    sideToMove: stm,
    inCheck,
    checks: checkingMoves(fen).slice(0, 8),
    captures: captureMoves(fen).slice(0, 8),
    threats,
    mateThreat: mateThreat ?? undefined,
    hangingPieces: hangingPieces(fen).map((h) => ({ square: h.square, piece: PIECE_NAMES[h.piece], colour: h.colour, value: h.value })),
    forcedMaterialGain,
    forcedMaterialLoss,
    criticality,
  };
}

/**
 * A mate `side` would deliver if it were their move. Chess has no pass, so this searches the
 * hypothetical position with `side` to move; it is only defined when the other king is not in check.
 */
async function findMateThreat(
  fen: string,
  side: Colour,
  probe: InsightOptions["probe"],
): Promise<MateThreat | null> {
  const hypothetical = fenWithSideToMove(fen, side);
  if (!hypothetical || hypothetical === fen) return null;
  const m1 = mateInOne(hypothetical);
  if (m1) {
    return { side, mateIn: 1, firstMove: m1.san, firstMoveUci: m1.lan, lineId: null, line: [m1.san], confidence: "forced" };
  }
  if (!probe) return null;
  const analysis = await probe(hypothetical);
  const line = analysis?.lines[0];
  if (!analysis || !line) return null;
  const mate = moverMate(line.evaluation, side);
  if (mate === null || mate <= 0 || mate > THREAT_SEARCH.maxMateIn) return null;
  return {
    side,
    mateIn: mate,
    firstMove: line.rootMoveSan,
    firstMoveUci: line.rootMoveUci,
    lineId: line.id,
    line: line.moves.map((m) => m.san),
    confidence: "forced",
  };
}
