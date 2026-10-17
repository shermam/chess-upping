// Builds public/openings.json from the lichess-org/chess-openings dataset:
// one entry per named opening, keyed by the position it reaches (the same
// key the app uses for engine evaluations: FEN without move counters, with
// `/` replaced by `_`). Run with `node scripts/build-openings.mjs`; the
// output is committed so builds need no network access.
import { writeFileSync } from 'node:fs';
import { Chess } from 'chess.js';

const BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/';
const FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'];

function keyOf(fen) {
  return fen.split(' ').slice(0, 4).join(' ').replace(/\//g, '_');
}

const entries = [];
const seen = new Set();
for (const file of FILES) {
  const res = await fetch(BASE + file);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const lines = (await res.text()).split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [eco, name, pgn] = line.split('\t');
    const chess = new Chess();
    const sans = pgn
      .replace(/\d+\.\s*/g, '')
      .trim()
      .split(/\s+/);
    try {
      for (const san of sans) chess.move(san);
    } catch (err) {
      console.warn(`skipping ${eco} ${name}: ${err.message}`);
      continue;
    }
    const key = keyOf(chess.fen());
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ k: key, e: eco, n: name, p: sans.length });
  }
}
entries.sort((a, b) => a.e.localeCompare(b.e) || a.p - b.p);
writeFileSync(new URL('../public/openings.json', import.meta.url), JSON.stringify(entries));
console.log(`wrote ${entries.length} openings`);
