// Text measuring, so a longer name from the Excel shrinks to fit instead of running off the design.

const mctx = document.createElement("canvas").getContext("2d");
const quoteFamily = (css) => (/[,"']/.test(css) ? css : `"${css}"`);

export function textWidth(line, css, size, tracking, hScale) {
  mctx.font = `${size}px ${quoteFamily(css)}`;
  const chars = [...line].length;
  return (mctx.measureText(line).width + (tracking || 0) / 1000 * size * Math.max(0, chars - 1)) * (hScale || 1);
}

// shrink 0.5pt at a time until every line fits the width. Never wraps: the text keeps
// exactly the lines it was given (a new line only where the Excel cell has one).
export function fitSize(text, css, size, tracking, hScale, maxW, minSize = 4) {
  if (!(maxW > 0)) return size;
  const lines = String(text).split("\n");
  const widest = (s) => Math.max(...lines.map((l) => textWidth(l, css, s, tracking, hScale)));
  while (size > minSize && widest(size) > maxW + 0.5) size = Math.round((size - 0.5) * 100) / 100;
  return size;
}
