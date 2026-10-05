# Sjeng (Apple Chess engine)

- **Engine:** Sjeng 11.2, as shipped inside Apple's Chess.app on macOS
- **Copyright:** © 2000–2001 Gian-Carlo Pascutto, with modifications by Apple
- **Licence:** GNU General Public License (see the licence text published with Apple's Chess source)
- **Source:** Apple open source releases of Chess (<https://github.com/apple-oss-distributions/Chess>)

ChessAnalyser does not include or redistribute Sjeng. On macOS, only when Stockfish is unavailable,
it may launch the copy already installed with the operating system
(`/System/Applications/Chess.app/Contents/Resources/sjeng.ChessEngine`) as a separate process over the
XBoard protocol. The UI always labels this mode as "Apple Chess fallback"; it never presents Sjeng's
output as Stockfish analysis.
