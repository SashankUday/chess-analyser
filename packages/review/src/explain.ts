// Structured, engine-grounded explanations (V2 plan §31–35). Every claim comes from an engine line
// or an exact chess-core fact; anything less certain falls back to conservative wording.
import { isFork, materialSequence, type Square } from "@chessanalyser/chess-core";
import {
  CLASSIFICATION_LABELS,
  LINE_DISPLAY_PLIES,
  RESULT_LABELS,
  formatEvaluation,
  moveNumberLabel,
  moverHasMate,
  moverIsMated,
  moverMate,
  opposite,
  resultRank,
  type Colour,
  type EngineLine,
  type GameMove,
  type MoveBadge,
  type MoveClassification,
  type MoveExplanation,
  type MoveQualityMetrics,
  type PositionInsights,
} from "@chessanalyser/shared";

export interface ExplainInput {
  move: GameMove;
  mover: Colour;
  classification: MoveClassification;
  metrics: MoveQualityMetrics;
  badges: MoveBadge[];
  bestLine: EngineLine | null;
  /** Same-root line of the played move (starts with the played move). */
  playedLine: EngineLine | null;
  insightsBefore: PositionInsights | null;
  insightsAfter: PositionInsights | null;
  /** The importing user's colour, for "you"/"your opponent" wording. */
  perspective: Colour | null;
  greatReason: "only_move" | "turnaround" | null;
  /** What a Brilliant move gave up, for the explanation. */
  sacrifice?: { amount: number; kind: string; acceptSan: string | null };
  previousResultClass: MoveQualityMetrics["resultClassBefore"] | null;
  reduced: boolean;
}

interface Persona {
  subject: string;
  possessive: string;
}

function persona(colour: Colour, user: Colour | null): Persona {
  if (user) {
    return colour === user ? { subject: "You", possessive: "your" } : { subject: "Your opponent", possessive: "your opponent's" };
  }
  const name = colour === "white" ? "White" : "Black";
  return { subject: name, possessive: `${name}'s` };
}

/** End a sentence with a full stop unless it already ends with one (or an ellipsis). */
const stop = (s: string) => (/[.…!?]$/.test(s) ? s : `${s}.`);

/** "23. Rc1 Nf4 24. Bxf4" style line from SAN moves starting at `firstPly` (capped for display). */
export function formatLine(sans: string[], firstPly: number): string {
  const shown = sans.slice(0, LINE_DISPLAY_PLIES);
  return shown
    .map((san, i) => {
      const ply = firstPly + i;
      return i === 0 || ply % 2 === 1 ? `${moveNumberLabel(ply)} ${san}` : san;
    })
    .join(" ")
    .concat(sans.length > shown.length ? " …" : "");
}

const POSITIVE = new Set<MoveClassification>(["brilliant", "great", "best", "excellent", "good", "forced"]);

export function explainMove(input: ExplainInput): MoveExplanation {
  const { move, mover, classification: c, metrics: m, bestLine, playedLine } = input;
  const me = persona(mover, input.perspective);
  const them = persona(opposite(mover), input.perspective);
  const label = CLASSIFICATION_LABELS[c];
  const startPly = move.ply; // the played move's own ply; lines from the pre-move root start here
  const out: MoveExplanation = { headline: label, summary: "", confidence: "low" };
  const sentences: string[] = [];

  if (c === "forced") {
    return { headline: "Forced", summary: "This was the only legal move.", confidence: "high" };
  }
  if (input.reduced) {
    const s = `${label}. ${bestLine && bestLine.rootMoveUci !== move.uci ? `${bestLine.rootMoveSan} was the engine's choice. ` : ""}(Reduced review: Apple Chess fallback.)`;
    return { headline: label, summary: s, confidence: "low" };
  }

  const bestSan = bestLine?.rootMoveSan ?? null;
  const playedIsBest = m.playedRank === 1;
  const replyMoves = playedLine ? playedLine.moves.slice(1) : [];
  const threatBefore = input.insightsBefore?.mateThreat && input.insightsBefore.mateThreat.side !== mover ? input.insightsBefore.mateThreat : null;
  const ownThreatAfter = input.insightsAfter?.mateThreat && input.insightsAfter.mateThreat.side === mover ? input.insightsAfter.mateThreat : null;
  const playedEval = playedLine?.evaluation ?? null;

  // ---- 1. Allows forced mate ----
  if (input.badges.includes("allows_mate") && playedEval) {
    const n = Math.abs(moverMate(playedEval, mover) ?? 0);
    const line = formatLine(replyMoves.slice(0, Math.max(1, n * 2 - 1)).map((x) => x.san), startPly + 1);
    out.headline = `${label} — allows mate${n ? ` in ${n}` : ""}`;
    out.consequence = stop(`${them.subject} now ${them.subject === "You" ? "have" : "has"} a forced mate${n ? ` in ${n}` : ""}: ${line}`);
    out.lineId = playedLine?.id;
    out.line = line;
    out.lineStartPly = startPly + 1;
    out.confidence = "high";
    if (threatBefore) out.threatBefore = `This does not stop ${them.possessive} threat of ${threatBefore.firstMove}.`;
  }
  // ---- 2. Misses forced mate ----
  else if (input.badges.includes("missed_mate") && bestLine) {
    const n = moverMate(bestLine.evaluation, mover) ?? 0;
    const line = formatLine(bestLine.moves.slice(0, Math.max(1, n * 2 - 1)).map((x) => x.san), startPly);
    out.headline = `${label} — missed mate${n ? ` in ${n}` : ""}`;
    out.consequence = stop(`There was a forced mate${n ? ` in ${n}` : ""} starting with ${bestSan}: ${line}`);
    out.lineId = bestLine.id;
    out.line = line;
    out.lineStartPly = startPly;
    out.confidence = "high";
  } else if (!POSITIVE.has(c) || c === "good") {
    // ---- 3/4. Material lost, immediately or later in the engine line ----
    const seq = playedLine ? materialSequence(move.fenBefore, playedLine.moves, mover) : null;
    if (seq && seq.net <= -1 && m.winPercentLoss >= 5) {
      const shown = playedLine!.moves.slice(0, Math.max(seq.plies, 2));
      const line = formatLine(shown.map((x) => x.san), startPly);
      const reply = replyMoves[0];
      const fork = reply && isFork(reply.fenAfter, reply.uci.slice(2, 4) as Square);
      const what = seq.description;
      out.headline = `${label} — loses ${what}`;
      out.consequence =
        seq.plies <= 2
          ? `This loses ${what}${reply ? ` to ${reply.san}` : ""}${fork ? ", a fork" : ""}.`
          : stop(`This eventually loses ${what}${fork ? `, starting with the fork ${reply!.san}` : ""}: ${line}`);
      out.lineId = playedLine!.id;
      out.line = line;
      out.lineStartPly = startPly;
      out.confidence = "high";
    }
    // ---- 5. Missed material win ----
    if (!out.consequence && bestLine && input.badges.includes("missed_material")) {
      const gain = materialSequence(move.fenBefore, bestLine.moves, mover);
      if (gain && gain.net >= 2) {
        const lost = materialSequence(move.fenBefore, bestLine.moves, opposite(mover));
        const line = formatLine(bestLine.moves.slice(0, Math.max(gain.plies, 2)).map((x) => x.san), startPly);
        out.headline = `${label} — missed a win of material`;
        out.consequence = stop(`${bestSan} would have won ${lost?.description ?? "material"}: ${line}`);
        out.lineId = bestLine.id;
        out.line = line;
        out.lineStartPly = startPly;
        out.confidence = "high";
      }
    }
  }

  // ---- 6. Mating threats (before → after) ----
  if (threatBefore && !out.threatBefore) {
    const stillMated = playedEval ? moverIsMated(playedEval, mover) : false;
    if (!stillMated && POSITIVE.has(c)) {
      out.threatBefore = `${them.subject} ${them.subject === "You" ? "were" : "was"} threatening ${threatBefore.firstMove}, and ${move.san} prevents it.`;
      out.confidence = out.confidence === "low" ? "high" : out.confidence;
    } else if (stillMated) {
      out.threatBefore = `This does not stop ${them.possessive} threat: ${threatBefore.firstMove} is now possible.`;
    }
  }
  if (ownThreatAfter && POSITIVE.has(c)) {
    sentences.push(
      `${me.subject} ${me.subject === "You" ? "are" : "is"} now threatening ${ownThreatAfter.mateIn === 1 ? ownThreatAfter.firstMove : `mate in ${ownThreatAfter.mateIn} with ${ownThreatAfter.firstMove}`}.`,
    );
    if (out.confidence === "low") out.confidence = "high";
  }

  // ---- 8. Result-class change ----
  const before = m.resultClassBefore;
  const after = m.resultClassAfter;
  if (!playedIsBest && before !== after && resultRank(after) < resultRank(before)) {
    out.positionChange = `${me.subject} went from ${RESULT_LABELS[before]} to ${RESULT_LABELS[after]}.`;
    if (out.confidence === "low") out.confidence = "medium";
  } else if (input.greatReason === "turnaround" && input.previousResultClass) {
    out.positionChange = `${me.subject} turned ${RESULT_LABELS[input.previousResultClass]} into ${RESULT_LABELS[after]}.`;
    out.confidence = "high";
  }

  // ---- Why the best move was better (Good/Excellent only get concrete reasons) ----
  if (bestLine && !playedIsBest && !POSITIVE_STRICT.has(c)) {
    const reason = bestMoveReason(input, me, them);
    if (reason && (!POSITIVE.has(c) || reason.concrete)) out.bestMoveReason = reason.text;
  }

  // ---- Headline and summary ----
  if (c === "brilliant") out.headline = "Brilliant — a sound sacrifice";
  else if (c === "great") out.headline = input.greatReason === "turnaround" ? "Great — finds the punishing move" : "Great — the only good move";
  else if (c === "best" && out.headline === label) out.headline = "Best move";
  else if ((c === "excellent" || c === "good") && out.headline === label) out.headline = `${label} move`;

  const lead =
    c === "brilliant"
      ? brilliantSentence(input.sacrifice)
      : c === "great"
        ? input.greatReason === "turnaround"
          ? "A great move that takes advantage of the previous mistake."
          : `A great move: the only move that holds the position${m.criticality ? ` (the next-best move gives up ${Math.round(m.criticality)}% winning chances)` : ""}.`
        : c === "best"
          ? playedIsBest
            ? "This is the engine's top choice."
            : "This is as strong as the engine's top choice."
          : c === "excellent"
            ? `An excellent move${bestSan ? `, nearly as strong as ${bestSan}` : ""}.`
            : c === "good"
              ? `A good move${bestSan ? `, though ${bestSan} was stronger` : ""}.`
              : `${label}.`;
  sentences.unshift(lead);
  if (out.threatBefore) sentences.push(out.threatBefore);
  if (out.consequence) sentences.push(out.consequence);
  if (out.positionChange) sentences.push(out.positionChange);
  if (!out.consequence && !out.positionChange && !POSITIVE.has(c) && m.winPercentLoss >= 5) {
    sentences.push(`This gives up about ${Math.round(m.winPercentLoss)}% of ${me.possessive} winning chances.`);
    if (out.confidence === "low") out.confidence = "medium";
  }
  if (out.bestMoveReason) sentences.push(out.bestMoveReason);
  out.summary = sentences.join(" ");
  return out;
}

const POSITIVE_STRICT = new Set<MoveClassification>(["brilliant", "great", "best", "forced"]);

function bestMoveReason(input: ExplainInput, _me: Persona, them: Persona): { text: string; concrete: boolean } | undefined {
  const { bestLine, move, mover, metrics: m } = input;
  if (!bestLine) return undefined;
  const best = bestLine.rootMoveSan;
  if (moverHasMate(bestLine.evaluation, mover)) {
    const n = moverMate(bestLine.evaluation, mover);
    return { text: `${best} forces mate${n ? ` in ${n}` : ""}.`, concrete: true };
  }
  const gain = materialSequence(move.fenBefore, bestLine.moves, mover);
  if (gain && gain.net >= 1) {
    const lost = materialSequence(move.fenBefore, bestLine.moves, opposite(mover));
    return { text: `${best} wins ${lost?.description ?? "material"}.`, concrete: true };
  }
  const threat = input.insightsBefore?.mateThreat;
  if (threat && threat.side !== mover && input.badges.includes("allows_mate")) {
    return { text: `${best} defends against ${them.possessive} threat of ${threat.firstMove}.`, concrete: true };
  }
  if (resultRank(m.resultClassBefore) > resultRank(m.resultClassAfter)) {
    // "Keeps a losing position" reads oddly: in worse positions the best move is the more resilient one.
    const text =
      resultRank(m.resultClassBefore) >= resultRank("EQUAL")
        ? `${best} keeps ${RESULT_LABELS[m.resultClassBefore]} (${formatEvaluation(bestLine.evaluation)}).`
        : `${best} was more resilient (${formatEvaluation(bestLine.evaluation)}).`;
    return { text, concrete: false };
  }
  return { text: `${best} was stronger (${formatEvaluation(bestLine.evaluation)}).`, concrete: false };
}

function brilliantSentence(sac: ExplainInput["sacrifice"]): string {
  if (!sac) return "A brilliant sacrifice: Stockfish confirms that taking the material does not refute it.";
  const what =
    sac.kind === "queen"
      ? "the queen"
      : sac.kind === "exchange"
        ? "the exchange"
        : sac.amount >= 5
          ? "a rook"
          : sac.amount >= 3
            ? "a piece"
            : sac.amount >= 2
              ? "material"
              : "a pawn";
  const taking = sac.acceptSan ? `taking it with ${sac.acceptSan}` : "accepting it";
  return `A brilliant sacrifice of ${what}: Stockfish confirms that ${taking} does not refute it.`;
}
