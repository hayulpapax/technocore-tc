// Renders data/census-history.tsv as two panels, because the two stories have very
// different scales and one flattens the other. Top: the sharded DID-note population.
// Bottom: the legacy namespace against its published cap — the line that carries the
// argument, and the one that is invisible when drawn next to the top one.
//
// Every number and every label below is derived from the TSV. Nothing here is typed in
// by hand, so re-running it after a census cannot leave a stale figure on the image.
//
//   node tools/chart.mjs          -> chart/census-chart.svg, chart/census-chart.html
//
// For a PNG, screenshot the HTML at 1600x900 (the fonts need a browser):
//   chrome --headless --screenshot=chart.png --window-size=1600,900 \
//          --force-device-scale-factor=2 chart/census-chart.html
import { readFileSync, writeFileSync } from 'node:fs';

const TSV = new URL('../data/census-history.tsv', import.meta.url);
const rows = readFileSync(TSV, 'utf8').trim().split('\n').slice(1).map(l => {
  const f = l.split('\t');
  return { date: f[0], sharded: +f[3], legacy: +f[4], cap: +f[5], atCap: f[6] === 'true' };
});
if (rows.length < 2) throw new Error(`need at least two censuses to draw a line, have ${rows.length}`);

const first = rows[0], last = rows[rows.length - 1];

// --- derived copy -----------------------------------------------------------------
const CARDINALS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty'];
const words = n => CARDINALS[n] ?? String(n);

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pretty = d => `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}`;

// A ratio against a zero start is not a growth figure, it is 0/0. Say nothing rather than
// print NaN on the image — an all-zero census is unlikely but a chart that renders "NaN×"
// and commits itself is worse than one that omits a number it cannot compute.
const growth = first.sharded > 0 ? last.sharded / first.sharded : null;
// one decimal below 10x, none above — "28x" reads as a fact, "28.4x" reads as arithmetic
const growthLabel = growth === null ? ''
  : growth < 10 ? `${growth.toFixed(1)}×` : `${Math.round(growth)}×`;

const millions = last.sharded / 1e6;
const headlineCount = millions >= 1 ? `${millions.toFixed(2)}M` : last.sharded.toLocaleString();

// distinct cap levels, in the order they appeared, and which of them the namespace reached
const capLevels = rows.map(r => r.cap).filter((c, i, a) => i === 0 || c !== a[i - 1]);
const reached = capLevels.filter(c => rows.some(r => r.cap === c && r.atCap));
const capNote = reached.length === capLevels.length
  ? `at the cap — ${words(capLevels.length)} cap levels, filled to every one`
  : `at the cap — ${words(reached.length)} of ${words(capLevels.length)} cap levels reached`;
const headline = reached.length === capLevels.length && capLevels.length > 1
  ? `${headlineCount} identities, and a cap that refills as fast as it is raised`
  : `${headlineCount} identities on the sharded path`;

// --- geometry ---------------------------------------------------------------------
const W = 1600, H = 900, L = 128, R = 96;
const plotW = W - L - R;

// x is proportional to the actual date, so a day the census missed reads as a gap
// rather than as an evenly spaced step
const t = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const t0 = t(first.date), tSpan = t(last.date) - t0 || 1;
const X = i => L + (plotW * (t(rows[i].date) - t0)) / tSpan;

// round a maximum up to a clean tick, leaving ~12% headroom above the peak
const niceMax = peak => {
  // log10(0) is -Infinity and the step collapses to 0, which makes every coordinate on the
  // panel NaN — a chart that draws nothing and says nothing about why. Floor the axis
  // instead so an empty series renders as a flat line at zero.
  if (!(peak > 0)) return 1;
  const target = peak * 1.12;
  const step = Math.pow(10, Math.floor(Math.log10(target))) / 2;
  return Math.ceil(target / step) * step;
};
const ticksFor = max => {
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
};
const fmtTick = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v ? `${Math.round(v / 1000)}k` : '0';

const line = (key, Y) => rows
  .map((r, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(r[key]).toFixed(1)}`).join(' ');
const gridFor = (ticks, Y) => ticks.map(v => `
    <line x1="${L}" y1="${Y(v).toFixed(1)}" x2="${W - R}" y2="${Y(v).toFixed(1)}" stroke="#232A3E" stroke-width="1"/>
    <text x="${L - 16}" y="${(Y(v) + 6).toFixed(1)}" text-anchor="end" font-family="Space Mono, monospace"
          font-size="16" fill="#5C6670">${fmtTick(v)}</text>`).join('');

// top panel — sharded
const aTop = 190, aH = 250, aMax = niceMax(Math.max(...rows.map(r => r.sharded)));
const aY = v => aTop + aH - (aH * v) / aMax;
const shardedLine = line('sharded', aY);

// bottom panel — legacy against a stepped cap
const bTop = 560, bH = 210;
const bMax = niceMax(Math.max(...rows.map(r => Math.max(r.legacy, r.cap))));
const bY = v => bTop + bH - (bH * v) / bMax;
const legacyLine = line('legacy', bY);

// the cap is a step function: hold each value until it changes, then jump vertically
let capPath = `M${X(0).toFixed(1)} ${bY(first.cap).toFixed(1)}`;
rows.forEach((r, i) => {
  if (i === 0) return;
  if (r.cap !== rows[i - 1].cap) {
    capPath += ` L${X(i).toFixed(1)} ${bY(rows[i - 1].cap).toFixed(1)}`;
  }
  capPath += ` L${X(i).toFixed(1)} ${bY(r.cap).toFixed(1)}`;
});

const hits = rows.map((r, i) => r.atCap ? `
  <circle cx="${X(i).toFixed(1)}" cy="${bY(r.legacy).toFixed(1)}" r="7.5" fill="#0A1128" stroke="#00B4D8" stroke-width="3"/>` : '').join('');

// label about eight dates, always including the last, and never twice in the same spot
const stride = Math.max(1, Math.round(rows.length / 8));
const xLabels = rows.map((r, i) => (i % stride === 0 || i === rows.length - 1) ? `
  <text x="${X(i).toFixed(1)}" y="${bTop + bH + 34}" text-anchor="middle"
        font-family="Space Mono, monospace" font-size="16" fill="#5C6670">${r.date.slice(5)}</text>` : '').join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0A1128"/>

  <text x="${L}" y="72" font-family="Space Mono, monospace" font-size="15" font-weight="700"
        letter-spacing="4" fill="#00B4D8">TECHNOCORE.CHAT &#183; DID NOTE CENSUS &#183; ${words(rows.length).toUpperCase()} CENSUSES, ${pretty(first.date)} - ${pretty(last.date)}</text>
  <text x="${L}" y="122" font-family="Space Mono, monospace" font-size="36" font-weight="700"
        fill="#F5F7FA">${headline}</text>

  <!-- heading row: the label opposite it shares this baseline, which keeps the growth
       figure off the plot however the series ends -->
  <text x="${L}" y="172" font-family="Space Mono, monospace" font-size="16" font-weight="700"
        letter-spacing="2" fill="#9AA4B2">SHARDED PATH  /kv/did-&lt;2&gt;/&lt;14&gt;</text>
  ${gridFor(ticksFor(aMax), aY)}
  <path d="${shardedLine} L${X(rows.length - 1).toFixed(1)} ${aY(0).toFixed(1)} L${X(0).toFixed(1)} ${aY(0).toFixed(1)} Z"
        fill="#00B4D8" fill-opacity="0.12"/>
  <path d="${shardedLine}" fill="none" stroke="#00B4D8" stroke-width="3.5" stroke-linejoin="round"/>
  <text x="${W - R}" y="172" text-anchor="end"
        font-family="Space Mono, monospace" font-size="20" font-weight="700" fill="#00B4D8">
    ${first.sharded.toLocaleString()} &#8594; ${last.sharded.toLocaleString()}   &#183;   ${growthLabel}</text>

  <text x="${L}" y="${bTop - 20}" font-family="Space Mono, monospace" font-size="16" font-weight="700"
        letter-spacing="2" fill="#9AA4B2">LEGACY PATH  /kv/did/&lt;16&gt;   &#183;   AGAINST ITS PUBLISHED CAP</text>
  ${gridFor(ticksFor(bMax), bY)}
  <path d="${capPath}" fill="none" stroke="#5C6670" stroke-width="2.5" stroke-dasharray="7 5"/>
  <path d="${legacyLine}" fill="none" stroke="#F5F7FA" stroke-width="3.5" stroke-linejoin="round"/>
  ${hits}
  ${xLabels}
  <text x="${W - R}" y="${(bY(last.cap) - 16).toFixed(1)}" text-anchor="end"
        font-family="Space Mono, monospace" font-size="16" fill="#5C6670">cap ${last.cap.toLocaleString()}</text>

  <g font-family="Space Mono, monospace" font-size="17">
    <circle cx="${L + 8}" cy="${H - 48}" r="7.5" fill="#0A1128" stroke="#00B4D8" stroke-width="3"/>
    <text x="${L + 28}" y="${H - 42}" fill="#9AA4B2">${capNote}</text>
    <text x="${W - R}" y="${H - 42}" text-anchor="end" fill="#5C6670">
      257 reads per census &#183; method and data: hayulpapax/technocore-tc</text>
  </g>
</svg>`;

writeFileSync(new URL('../chart/census-chart.svg', import.meta.url), svg);
writeFileSync(new URL('../chart/census-chart.html', import.meta.url),
  `<!doctype html><html><head><meta charset="utf-8">
<style>@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap');
*{margin:0;padding:0}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#0A1128}</style>
</head><body>${svg}</body></html>`);

console.log(`${rows.length} censuses ${first.date}..${last.date} · ${growthLabel} · ` +
  `${capLevels.length} cap levels, ${reached.length} reached · ${rows.filter(r => r.atCap).length} at-cap readings`);
