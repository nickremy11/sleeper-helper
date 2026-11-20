// Reading the image model's answer for /api/ranks/image (handleRanksImage in index.js).
//
// The model writes one line per printed row (see RANKS_IMAGE_PROMPT):
//   # Rank Quarterback Team Opp Tier      ← a table header
//   1 | Josh Allen | BUF | MIA | 1        ← a data row, cells in printed order
// This turns that back into the {tables:[{header, rows}]} shape the client has
// always read, so the client's row classifier (luImageRow) is unchanged.
//
// Plain lines instead of JSON because generation speed is the bottleneck: the
// same band is ~30-40% fewer output tokens (measured on Mistral Small 3.1, a
// 9-column sheet: 23s vs 32s end to end), and there are no brackets to close.
//
// The spaces around the pipes matter. Measured 2026-11-19 on the WR 1-50
// column: tight pipes ("1|Josh Allen|BUF|MIA|1") put the wrong row's team and
// opponent on 12-19 of 50 rows, every run; " | " got all 50 right, as did JSON.
// The `#` line must be told to appear at the top of a strip too — without that,
// Mistral dropped the "Running Back" header and the RBs would land under TE.
export function parseRankLines(text) {
  const tables = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      // The model sometimes puts | between header words too — a header is just text.
      const header = line.replace(/^#+/, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
      cur = { header: header || null, rows: [] };
      tables.push(cur);
      continue;
    }
    // A data row starts with its rank. Anything else (prose, ``` fences) is skipped.
    if (!line.includes('|')) continue;
    // `|1|name|…|` (markdown-table style) has an outer pipe on each end; a lone
    // trailing pipe is an empty last cell.
    const body = line.startsWith('|') ? line.slice(1).replace(/\|$/, '') : line;
    const cells = body.split('|').map(c => c.trim());
    if (!/^\d+$/.test(cells[0])) continue;
    if (!cur) { cur = { header: null, rows: [] }; tables.push(cur); }   // strip starts mid-table
    cur.rows.push(cells.map(c => (c === '' ? null : c)));
  }
  return tables.filter(t => t.rows.length || t.header);
}
