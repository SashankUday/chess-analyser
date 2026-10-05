import { legalMoveCount, materialFor, staticExchange, threatenedLoss, type Square } from "@chessanalyser/chess-core";
import { BRILLIANT, expectedScore, type Colour, type EngineAnalysis, type GameMove } from "@chessanalyser/shared";

export interface BrilliantCandidateInput {
  move: GameMove;
  previousMove: GameMove | null;
  mover: Colour;
  /** Expected-outcome loss of the played move (0 if it was the engine's best). */
  loss: number;
  /** Analysis of the position after the move (its PV is the opponent's best reply line). */
  after: EngineAnalysis;
}

export interface ConcessionResult {
  concession: number;
  reason: "en_prise" | "leaves_piece_en_prise" | "pv_material_dip" | null;
}

/**
 * ChessAnalyser's own Brilliant definition (spec §13). Kept separate from the classifier so the rule
 * can evolve independently: (A) engine quality, (B) apparent concession, (C) compensation,
 * (D) non-triviality, (E) targeted engine confirmation.
 */
export class BrilliantDetector {
  /** Cheap deterministic screen (A–D) run on every move; candidates then get engine verification (E). */
  isCandidate(input: BrilliantCandidateInput): boolean {
    const { move, previousMove, loss } = input;
    // A. Engine quality — and C. compensation: the engine rates the result as no worse than best play.
    if (loss > BRILLIANT.maxLoss) return false;
    // D. Non-triviality.
    if (legalMoveCount(move.fenBefore) <= 1) return false;
    if (move.san.endsWith("#")) return false;
    if (previousMove && /x/.test(previousMove.san) && previousMove.uci.slice(2, 4) === move.uci.slice(2, 4)) return false;
    // B. Apparent concession of at least about a pawn (this also rules out routine exchanges and
    // automatic promotions, which concede nothing).
    return this.concession(input).concession >= BRILLIANT.minConcession;
  }

  concession(input: BrilliantCandidateInput): ConcessionResult {
    const { move, mover, after } = input;
    const from = move.uci.slice(0, 2);
    const to = move.uci.slice(2, 4);

    // The moved piece itself can be won.
    const see = staticExchange(move.fenBefore, { from, to, promotion: move.uci[4] });
    if (-see >= BRILLIANT.minConcession) return { concession: -see, reason: "en_prise" };

    // The move leaves something else en prise that was safe before.
    const threatBefore = threatenedLoss(move.fenBefore, mover);
    const threatAfter = threatenedLoss(move.fenAfter, mover);
    const capturedNow = Math.max(0, see);
    const newlyExposed = threatAfter.loss - Math.max(threatBefore.loss, 0) - capturedNow;
    if (threatAfter.square !== (to as Square) && newlyExposed >= BRILLIANT.minConcession) {
      return { concession: newlyExposed, reason: "leaves_piece_en_prise" };
    }

    // Material dips along the engine's best continuation (a sacrifice accepted a move later). The dip
    // must survive the mover's next move, so an ordinary capture–recapture does not count.
    const baseline = materialFor(move.fenBefore, mover);
    const pv = (after.lines[0]?.moves ?? []).slice(0, BRILLIANT.pvScanPlies);
    let dip = 0;
    for (let i = 0; i < pv.length; i += 2) {
      const afterOpponent = baseline - materialFor(pv[i]!.fenAfter, mover);
      const afterReply = pv[i + 1] ? baseline - materialFor(pv[i + 1]!.fenAfter, mover) : afterOpponent;
      dip = Math.max(dip, Math.min(afterOpponent, afterReply));
    }
    if (dip >= BRILLIANT.minConcession) return { concession: dip, reason: "pv_material_dip" };
    return { concession: 0, reason: null };
  }

  /**
   * E. Engine confirmation with a MultiPV 3, higher-budget search of the position before the move:
   * the played move must be ranked first, or within the Brilliant loss margin of the best line.
   */
  confirm(verification: EngineAnalysis, move: GameMove, mover: Colour): boolean {
    const best = verification.lines[0];
    if (!best) return false;
    if (best.rootMoveUci === move.uci) return true;
    const played = verification.lines.find((l) => l.rootMoveUci === move.uci);
    if (!played || !played.wdl || !best.wdl) return false;
    return expectedScore(best.wdl, mover) - expectedScore(played.wdl, mover) <= BRILLIANT.maxLoss;
  }
}
