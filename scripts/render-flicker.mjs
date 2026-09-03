import { computeModel, DOT_R } from 'flicker-dot';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Ripple — Made with Flicker · flicker.laurie.fyi
const RIPPLE_GRIDS = [
  [
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    true, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false,
  ],
  [
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false, true, false, false, false, false, false, true,
    true, true, false, false, false, false, false, true,
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false,
  ],
  [
    false, false, false, false, false, false, false, false,
    false, false, true, false, false, false, false, false,
    true, false, true, false, false, false, true, false,
    true, false, true, false, false, false, true, false,
    true, false, false, false, false, false, true, false,
    false, false, false, false, false, false, false, false,
    false,
  ],
  [
    false, false, true, true, true, false, false, false,
    true, true, false, true, true, false, true, true,
    false, true, false, true, true, true, false, true,
    false, true, false, true, true, true, false, true,
    false, true, true, false, true, true, false, true,
    true, false, false, false, true, true, true, false,
    false,
  ],
  [
    false, true, true, false, true, true, false, true,
    true, false, true, false, true, true, true, false,
    true, false, true, false, true, false, true, false,
    false, false, true, false, true, false, true, false,
    true, false, true, true, true, false, true, false,
    true, true, false, true, true, false, true, true,
    false,
  ],
  [
    true, true, false, true, false, true, true, true,
    false, true, false, true, false, true, false, true,
    false, false, false, true, false, true, false, false,
    false, false, false, true, false, true, false, false,
    false, true, false, true, false, true, false, true,
    false, true, true, true, false, true, false, true,
    true,
  ],
  [
    true, false, true, false, true, false, true, false,
    true, false, false, false, true, false, true, false,
    false, false, false, false, true, false, false, false,
    false, false, false, false, true, false, false, false,
    false, false, true, false, true, false, false, false,
    true, false, true, false, true, false, true, false,
    true,
  ],
  [
    true, true, false, false, false, true, true, true,
    false, false, false, false, false, true, false, false,
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false, false, false, true, false, false, false, false,
    false, true, true, true, false, false, false, true,
    true,
  ],
  [
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false,
    false,
  ],
];

function parseDigit(rows) {
  const bits = rows.flatMap((row) => [...row].map((ch) => ch === '1'));
  if (bits.length !== 49) throw new Error(`Digit must be 7x7, got ${bits.length}`);
  return bits;
}

// 7x7 flip-dot glyphs, 5 through 1
const DIGITS = {
  5: parseDigit([
    '0111110',
    '0100000',
    '0100000',
    '0111110',
    '0000010',
    '0000010',
    '0111110',
  ]),
  4: parseDigit([
    '0100010',
    '0100010',
    '0100010',
    '0111110',
    '0000010',
    '0000010',
    '0000010',
  ]),
  3: parseDigit([
    '0111110',
    '0000010',
    '0000010',
    '0111110',
    '0000010',
    '0000010',
    '0111110',
  ]),
  2: parseDigit([
    '0111110',
    '0000010',
    '0000010',
    '0111110',
    '0100000',
    '0100000',
    '0111110',
  ]),
  1: parseDigit([
    '0011000',
    '0001000',
    '0001000',
    '0001000',
    '0001000',
    '0001000',
    '0111110',
  ]),
};

function chebyshevFromCenter(i) {
  const row = Math.floor(i / 7);
  const col = i % 7;
  return Math.max(Math.abs(row - 3), Math.abs(col - 3));
}

function rippleDigit(digit, ring) {
  return digit.map((on, i) => on && chebyshevFromCenter(i) <= ring);
}

function countdownGrids() {
  const frames = [];
  for (const n of [5, 4, 3, 2, 1]) {
    const glyph = DIGITS[n];
    for (let ring = 0; ring <= 3; ring++) frames.push(rippleDigit(glyph, ring));
    frames.push(glyph, glyph);
  }
  return frames;
}

function renderFlickerSvg(grids, {
  uid,
  className,
  size,
  title,
  duration,
  iteration = 'infinite',
}) {
  const model = computeModel(grids, false);
  const kf = (key) => `${uid}_${key}`;
  const dur = duration || model.duration;
  const fill = iteration === 'infinite' ? '' : ' forwards';
  const css =
    `[data-fk="${uid}"] circle{fill:var(--off)}` +
    `[data-fk="${uid}"] circle.on{fill:var(--on)}` +
    `@media (prefers-reduced-motion: reduce){[data-fk="${uid}"] circle{animation:none!important}}` +
    model.keyframes.map((k) => `@keyframes ${kf(k.key)}{${k.stops.join(' ')}}`).join('');

  const baseCircles = model.dots
    .map((d) => `<circle cx="${d.cx}" cy="${d.cy}" r="${DOT_R}"/>`)
    .join('');

  const overlayCircles = model.dots
    .map((d) => {
      if (d.kind === 'off') return '';
      if (d.kind === 'on-static') {
        return `<circle class="on" cx="${d.cx}" cy="${d.cy}" r="${DOT_R}"/>`;
      }
      const opacity = d.initialOn ? 1 : 0;
      return `<circle class="on" cx="${d.cx}" cy="${d.cy}" r="${DOT_R}" opacity="${opacity}" style="animation:${kf(d.key)} var(--dur) linear ${iteration}${fill}"/>`;
    })
    .join('');

  return `<!-- Made with Flicker · flicker.laurie.fyi -->
<svg data-fk="${uid}" class="${className}" width="${size}" height="${size}" viewBox="0 0 ${model.viewBox} ${model.viewBox}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${title}" style="--on: var(--flicker-on); --off: var(--flicker-off); --dur: ${dur};">
<title>${title}</title>
<style>${css}</style>
${baseCircles}
${overlayCircles}
</svg>`;
}

const boot = renderFlickerSvg(RIPPLE_GRIDS, {
  uid: 'fkboot',
  className: 'boot-spinner',
  size: 40,
  title: 'Loading',
});
writeFileSync(join(publicDir, 'flicker-boot.svg'), boot, 'utf8');

const countdown = renderFlickerSvg(countdownGrids(), {
  uid: 'fkcd',
  className: 'countdown-flicker-svg',
  size: 180,
  title: 'Countdown',
  duration: '5s',
  iteration: '1',
});
writeFileSync(join(publicDir, 'flicker-countdown.svg'), countdown, 'utf8');

console.log('Wrote flicker-boot.svg and flicker-countdown.svg');
