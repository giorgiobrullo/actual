// Label placement for the Sankey chart. Recharts positions the nodes; this
// decides which of them get a label, on which side, and how much of the name
// fits, so that no two labels overprint each other anywhere in the chart.

export type SankeyLabelNode = {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  value: string;
};

export type SankeyLabelPlan = {
  anchor: 'start' | 'end';
  x: number;
  name: string;
  nameY: number;
  // null when only the name line fits
  value: string | null;
  valueY: number;
};

export type MeasureText = (text: string, fontSize: number) => number;

export const NAME_FONT_SIZE = 13;
export const VALUE_FONT_SIZE = 11;

const LABEL_GAP = 6;
// Glyph extents around the baseline, for the two font sizes above.
const NAME_ASCENT = 10;
const NAME_DESCENT = 3;
const VALUE_LINE_OFFSET = 13;
const VALUE_DESCENT = 3;
// Breathing room kept between two labels.
const LABEL_MARGIN = 2;
// A name cut below this many characters says nothing; drop the label instead.
const MIN_VISIBLE_CHARS = 3;
// Labels sit at a node's vertical middle, but no further down than this: the
// middle of a node hundreds of pixels tall can be off-screen while its top is
// in view.
const MAX_LABEL_DROP = 40;
// Vertical nudges tried, in order, when a label's natural spot is taken.
const LABEL_SHIFTS = [0, 3, -3, 6, -6, 9, -9];
const ELLIPSIS = '…';

type Box = { left: number; right: number; top: number; bottom: number };

function overlaps(a: Box, b: Box) {
  return (
    a.left < b.right + LABEL_MARGIN &&
    a.right + LABEL_MARGIN > b.left &&
    a.top < b.bottom + LABEL_MARGIN &&
    a.bottom + LABEL_MARGIN > b.top
  );
}

// The longest prefix of `text` that fits in `maxWidth`, with an ellipsis when
// it had to be cut. Null when not even a few characters fit.
export function fitText(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: MeasureText,
): string | null {
  if (measure(text, fontSize) <= maxWidth) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (
      measure(text.slice(0, mid).trimEnd() + ELLIPSIS, fontSize) <= maxWidth
    ) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  if (low < Math.min(MIN_VISIBLE_CHARS, text.length)) {
    return null;
  }
  return text.slice(0, low).trimEnd() + ELLIPSIS;
}

export function planSankeyLabels(
  nodes: SankeyLabelNode[],
  measure: MeasureText,
): Map<number, SankeyLabelPlan> {
  const columns = [...new Set(nodes.map(node => Math.round(node.x)))].sort(
    (a, b) => a - b,
  );
  const nodeWidth = nodes[0]?.width ?? 0;
  const placed: Box[] = [];
  const plans = new Map<number, SankeyLabelPlan>();

  // Bigger nodes claim their label space first: when two labels collide, the
  // one describing more money wins. Everything unlabelled keeps its tooltip.
  const byImportance = [...nodes].sort(
    (a, b) => b.height - a.height || a.index - b.index,
  );

  for (const node of byImportance) {
    if (!node.name) {
      continue;
    }
    const column = columns.indexOf(Math.round(node.x));
    // The last column has nothing to its right, so its labels sit on the left.
    const anchor =
      column === columns.length - 1 && columns.length > 1 ? 'end' : 'start';

    // A label may use the gap up to the neighbouring column, never cross it.
    let textX: number;
    let available: number;
    if (anchor === 'start') {
      textX = node.x + node.width + LABEL_GAP;
      const limit =
        column + 1 < columns.length ? columns[column + 1] - LABEL_GAP : null;
      available = limit === null ? Infinity : limit - textX;
    } else {
      textX = node.x - LABEL_GAP;
      const limit =
        column > 0 ? columns[column - 1] + nodeWidth + LABEL_GAP : 0;
      available = textX - limit;
    }

    const name = fitText(node.name, available, NAME_FONT_SIZE, measure);
    if (name === null) {
      continue;
    }
    const nameWidth = measure(name, NAME_FONT_SIZE);
    const valueWidth = measure(node.value, VALUE_FONT_SIZE);
    const middle = node.y + Math.min(node.height / 2, MAX_LABEL_DROP);

    const box = (width: number, top: number, bottom: number): Box =>
      anchor === 'start'
        ? { left: textX, right: textX + width, top, bottom }
        : { left: textX - width, right: textX, top, bottom };

    const isFree = (candidate: Box) =>
      !placed.some(other => overlaps(candidate, other));

    // Prefer name and amount on two lines around the node's middle; fall back
    // to the name alone, centred; otherwise leave the node to its tooltip.
    // Either may shift a few pixels to clear a neighbour, as long as the text
    // still starts beside its own node.
    const layouts: Array<Omit<SankeyLabelPlan, 'anchor' | 'x' | 'name'>> = [];
    if (node.value && valueWidth <= available) {
      layouts.push({
        nameY: middle,
        value: node.value,
        valueY: middle + VALUE_LINE_OFFSET,
      });
    }
    const nameBaseline = middle + (NAME_ASCENT - NAME_DESCENT) / 2;
    layouts.push({ nameY: nameBaseline, value: null, valueY: nameBaseline });

    search: for (const layout of layouts) {
      const width = layout.value ? Math.max(nameWidth, valueWidth) : nameWidth;
      const bottom = layout.value ? VALUE_DESCENT : NAME_DESCENT;
      for (const shift of LABEL_SHIFTS) {
        const nameY = layout.nameY + shift;
        // The name line must stay level with some part of its node.
        if (nameY - NAME_ASCENT > node.y + node.height + LABEL_MARGIN) continue;
        if (nameY + NAME_DESCENT < node.y - LABEL_MARGIN) continue;
        const candidate = box(
          width,
          nameY - NAME_ASCENT,
          layout.valueY + shift + bottom,
        );
        if (isFree(candidate)) {
          placed.push(candidate);
          plans.set(node.index, {
            anchor,
            x: textX,
            name,
            nameY,
            value: layout.value,
            valueY: layout.valueY + shift,
          });
          break search;
        }
      }
    }
  }

  return plans;
}
