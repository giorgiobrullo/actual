import { describe, expect, it } from 'vitest';

import { fitText, planSankeyLabels } from './sankeyLabels';
import type { SankeyLabelNode } from './sankeyLabels';

// Every glyph is fontSize * 0.5 wide.
const measure = (text: string, fontSize: number) =>
  text.length * fontSize * 0.5;

function node(
  index: number,
  x: number,
  y: number,
  height: number,
  name = `Node ${index}`,
): SankeyLabelNode {
  return { index, x, y, width: 10, height, name, value: '1.00' };
}

describe('fitText', () => {
  it('keeps text that fits', () => {
    expect(fitText('Travel', 100, 10, measure)).toBe('Travel');
  });

  it('cuts with an ellipsis', () => {
    // 6 glyphs of 5px fit in 30px: five letters and the ellipsis.
    expect(fitText('Accommodation', 30, 10, measure)).toBe('Accom…');
  });

  it('gives up when only a sliver would remain', () => {
    expect(fitText('Accommodation', 12, 10, measure)).toBeNull();
  });
});

describe('planSankeyLabels', () => {
  it('labels to the right, and to the left in the last column', () => {
    const plan = planSankeyLabels(
      [node(0, 0, 0, 100), node(1, 400, 0, 100)],
      measure,
    );
    expect(plan.get(0)).toMatchObject({ anchor: 'start', x: 16 });
    expect(plan.get(1)).toMatchObject({ anchor: 'end', x: 394 });
  });

  it('never lets a label run into the next column', () => {
    const plan = planSankeyLabels(
      [node(0, 0, 0, 100, 'A very long payee name'), node(1, 100, 0, 100)],
      measure,
    );
    const name = plan.get(0)?.name ?? '';
    expect(name.endsWith('…')).toBe(true);
    // label starts at 16 and must end before the next column at 100 - 6
    expect(16 + measure(name, 13)).toBeLessThanOrEqual(94);
  });

  it('drops the smaller of two colliding labels, across columns', () => {
    // Column 1's labels point right, column 2's (the last) point left: both
    // land in the gap between them at the same height.
    const plan = planSankeyLabels(
      [
        node(0, 0, 0, 10),
        node(1, 200, 0, 60, 'Bigger category'),
        node(2, 400, 22, 10, 'Smaller category'),
      ],
      measure,
    );
    expect(plan.has(1)).toBe(true);
    expect(plan.has(2)).toBe(false);
  });

  it('drops the amount when only the name fits beside the node', () => {
    // 30px between the label start and the next column: 'Ab' fits, an
    // eight-character amount does not.
    const plan = planSankeyLabels(
      [{ ...node(0, 0, 0, 10, 'Ab'), value: '1,234.56' }, node(1, 52, 0, 10)],
      measure,
    );
    expect(plan.get(0)).toMatchObject({ name: 'Ab', value: null });
  });

  it('nudges a label clear of a neighbour rather than dropping it', () => {
    // Node 0 takes two lines down to y=17; node 1's centred label would start
    // above that, so it moves a few pixels down instead.
    const plan = planSankeyLabels(
      [node(0, 0, 0, 2), node(1, 0, 22, 2), node(2, 400, 0, 2)],
      measure,
    );
    expect(plan.get(0)?.value).toBe('1.00');
    expect(plan.get(1)?.name).toBe('Node 1');
    expect(plan.get(1)?.nameY).toBeGreaterThan(23);
  });

  it('keeps labels of very tall nodes near their top', () => {
    const plan = planSankeyLabels(
      [node(0, 0, 0, 1000), node(1, 400, 0, 10)],
      measure,
    );
    expect(plan.get(0)?.nameY).toBe(40);
  });
});
