# Stockfish

- **Engine:** Stockfish
- **Version used by ChessAnalyser:** 19 (release `sf_19`, 5 September 2026)
- **Copyright:** © The Stockfish developers (see the AUTHORS file in the Stockfish distribution)
- **Licence:** GNU General Public License v3.0
- **Source:** <https://github.com/official-stockfish/Stockfish> (tag `sf_19`)

ChessAnalyser does not include or redistribute Stockfish. On first use it downloads the official
Stockfish 19 release binary for your platform directly from the Stockfish GitHub release, verifies its
SHA-256 checksum against `engine-manifest.json`, and stores it in your user data folder together with
Stockfish's own `Copying.txt` licence file. ChessAnalyser communicates with Stockfish as a separate
program over the UCI protocol.

Stockfish is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the License,
or (at your option) any later version. Stockfish is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See <https://www.gnu.org/licenses/gpl-3.0.html>.

If ChessAnalyser ever bundles Stockfish binaries in its own release packages, GPL compliance
(including source availability) must be reviewed before that distribution model is adopted.
