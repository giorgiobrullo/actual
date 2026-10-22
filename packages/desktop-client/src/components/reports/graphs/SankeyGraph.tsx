import { useEffect, useLayoutEffect, useState } from 'react';
import type { CSSProperties } from 'react';

import { theme } from '@actual-app/components/theme';
import { css, keyframes } from '@emotion/css';
import { t } from 'i18next';
import { Layer, ResponsiveContainer, Sankey, Tooltip } from 'recharts';
import type { SankeyData } from 'recharts/types/chart/Sankey';

import { Container } from '#components/reports/Container';
import { useFormat } from '#hooks/useFormat';
import { usePrivacyMode } from '#hooks/usePrivacyMode';
import { useReducedMotion } from '#hooks/useReducedMotion';

import {
  NAME_FONT_SIZE,
  planSankeyLabels,
  VALUE_FONT_SIZE,
} from './sankeyLabels';
import type { SankeyLabelNode, SankeyLabelPlan } from './sankeyLabels';

const fadeIn = keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

// kept invisible until the card scrolls into view
const hiddenClass = css({ opacity: 0 });

// stagger the load fade-in left-to-right, keyed off horizontal position
function fadeInClass(fraction: number) {
  const delay = Math.max(0, Math.min(1, fraction)) * 0.3;
  return css({
    animation: `${fadeIn} 0.3s ease-out ${delay}s both`,
  });
}

type SankeyGraphNode = SankeyData['nodes'][number] & {
  value: number;
  percentageLabel?: string;
  key: string;
  color?: string;
};

type SankeyLinkPayload = {
  source: SankeyGraphNode;
  target: SankeyGraphNode;
  value: number;
  color?: string;
};

type SankeyLinkProps = {
  sourceX: number;
  sourceY: number;
  sourceControlX: number;
  targetX: number;
  targetY: number;
  targetControlX: number;
  linkWidth: number;
  containerWidth: number;
  phase: 'waiting' | 'animating' | 'done';
  payload: SankeyLinkPayload;
  isHovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
};

function SankeyLink({
  sourceX,
  sourceY,
  sourceControlX,
  targetX,
  targetY,
  targetControlX,
  linkWidth,
  containerWidth,
  phase,
  payload,
  isHovered,
  onMouseEnter,
  onMouseLeave,
}: SankeyLinkProps) {
  const reducedMotion = useReducedMotion();

  if (payload.value <= 0) {
    return null;
  }
  const linkColor = payload.color ?? theme.reportsGray;
  const fillOpacity = isHovered ? 0.9 : 0.6;
  // use the link's midpoint so it eases in with the columns it spans
  const fraction = (sourceX + targetX) / 2 / containerWidth;
  // Draw the band as a filled ribbon between two curves. A stroked curve this
  // wide bulges past its endpoints wherever it bends, so a thick flow between
  // two offset nodes swept across neighbouring columns.
  const half = Math.max(0.5, linkWidth / 2);
  const d = [
    `M${sourceX},${sourceY - half}`,
    `C${sourceControlX},${sourceY - half} ${targetControlX},${targetY - half} ${targetX},${targetY - half}`,
    `L${targetX},${targetY + half}`,
    `C${targetControlX},${targetY + half} ${sourceControlX},${sourceY + half} ${sourceX},${sourceY + half}`,
    'Z',
  ].join(' ');

  return (
    <path
      className={
        reducedMotion || phase === 'done'
          ? undefined
          : phase === 'animating'
            ? fadeInClass(fraction)
            : hiddenClass
      }
      d={d}
      fill={linkColor}
      fillOpacity={fillOpacity}
      cursor="default"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ transition: 'fill-opacity 0.2s ease' }}
    />
  );
}

type SankeyNodeProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  payload: SankeyGraphNode;
  containerWidth: number;
  phase: 'waiting' | 'animating' | 'done';
  showPercentages?: boolean;
  color?: string;
  label: SankeyLabelPlan | undefined;
};
function SankeyNode({
  x,
  y,
  width,
  height,
  index,
  payload,
  containerWidth,
  phase,
  showPercentages,
  label,
}: SankeyNodeProps) {
  const privacyMode = usePrivacyMode();
  const format = useFormat();
  const reducedMotion = useReducedMotion();

  if (payload.value <= 0) {
    return null;
  }

  const fillColor = payload.color ?? theme.reportsBlue;
  const valueText =
    showPercentages && payload.percentageLabel
      ? payload.percentageLabel
      : format(payload.value, 'financial');

  // A halo in the background colour keeps a label readable where it crosses
  // the flows leaving its node.
  const textStyle = {
    stroke: theme.tableBackground,
    strokeWidth: 3,
    strokeLinejoin: 'round',
    paintOrder: 'stroke',
  } as const;

  return (
    <Layer
      className={
        reducedMotion || phase === 'done'
          ? undefined
          : phase === 'animating'
            ? fadeInClass(x / containerWidth)
            : hiddenClass
      }
    >
      {/* The label planner reads node geometry and text back from here. */}
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fillColor}
        data-sankey-node={index}
        data-sankey-name={payload.name || ''}
        data-sankey-value={valueText}
      />
      {label && (
        <text
          textAnchor={label.anchor}
          x={label.x}
          y={label.nameY}
          fontSize={NAME_FONT_SIZE}
          fill={theme.pageText}
          {...textStyle}
        >
          {label.name}
        </text>
      )}
      {label?.value && (
        <text
          textAnchor={label.anchor}
          x={label.x}
          y={label.valueY}
          fontSize={VALUE_FONT_SIZE}
          fill={theme.pageText}
          fillOpacity={0.7}
          fontFamily={privacyMode ? t('Redacted Script') : undefined}
          {...textStyle}
        >
          {label.value}
        </text>
      )}
    </Layer>
  );
}

// How many nodes the busiest column holds, as recharts lays them out: a node
// sits one column past the deepest of its sources, and nodes with no outgoing
// link may be pushed to the last column, so count those as one column too.
export function widestColumn(data: SankeyData): number {
  const depth = data.nodes.map(() => 0);
  for (let pass = 0; pass < data.nodes.length; pass++) {
    let changed = false;
    for (const link of data.links) {
      const source = link.source as number;
      const target = link.target as number;
      if (depth[target] < depth[source] + 1) {
        depth[target] = depth[source] + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const perColumn = new Map<number, number>();
  depth.forEach(d => perColumn.set(d, (perColumn.get(d) ?? 0) + 1));
  const hasOutgoing = new Set(data.links.map(link => link.source as number));
  const sinks = data.nodes.filter((_, i) => !hasOutgoing.has(i)).length;
  return Math.max(1, sinks, ...perColumn.values());
}

const MAX_NODE_PADDING = 23;
const CHART_MARGIN = { left: 0, right: 0, top: 10, bottom: 25 };
// Room a node needs for its two label lines when the chart may grow.
const PX_PER_NODE_TO_FIT = 34;

// The height at which every node of the busiest column can carry its label.
function sankeyHeightToFit(data: SankeyData): number {
  return (
    widestColumn(data) * PX_PER_NODE_TO_FIT +
    CHART_MARGIN.top +
    CHART_MARGIN.bottom
  );
}

let measureContext: CanvasRenderingContext2D | null | undefined;
function measureWith(fontFamily: string) {
  measureContext ??= document.createElement('canvas').getContext('2d');
  return (text: string, fontSize: number) => {
    if (!measureContext) {
      // No canvas: assume a generous average glyph width.
      return text.length * fontSize * 0.62;
    }
    measureContext.font = `${fontSize}px ${fontFamily}`;
    return measureContext.measureText(text).width;
  };
}

// Reads back the nodes recharts drew, in a form the planner understands.
function readRenderedNodes(root: HTMLElement): SankeyLabelNode[] {
  return [...root.querySelectorAll<SVGElement>('[data-sankey-node]')].map(
    el => {
      const box = (el as SVGGraphicsElement).getBBox();
      return {
        index: Number(el.dataset.sankeyNode),
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        name: el.dataset.sankeyName ?? '',
        value: el.dataset.sankeyValue ?? '',
      };
    },
  );
}

type SankeyGraphProps = {
  style?: CSSProperties;
  data: SankeyData;
  showTooltip?: boolean;
  showPercentages?: boolean;
  // Render fully visible from the first frame. The load animation gates on an
  // IntersectionObserver, which never fires for the offscreen copy the image
  // export draws — without this, the exported PNG would be blank.
  animationDisabled?: boolean;
  // Grow taller than the container (the page scrolls) when the busiest column
  // needs more room, instead of squeezing every node into the available height.
  growToFit?: boolean;
};
export function SankeyGraph({
  style,
  data,
  showTooltip = true,
  showPercentages = false,
  animationDisabled = false,
  growToFit = false,
}: SankeyGraphProps) {
  const privacyMode = usePrivacyMode();
  const format = useFormat();
  const [hoveredLinkIndex, setHoveredLinkIndex] = useState<number | null>(null);

  // play the load animation once: wait until the card scrolls into view,
  // run the fade-in, then stay in 'done' so later data changes (filters,
  // date range) don't re-animate the chart in place. the viewport element
  // is tracked as state because AutoSizer renders it on a later tick, so a
  // useRef-based observer would attach before the element exists.
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<'waiting' | 'animating' | 'done'>(
    animationDisabled ? 'done' : 'waiting',
  );

  // Labels are placed after recharts has laid the nodes out: render the nodes,
  // read their geometry back, plan labels for the whole chart at once, and
  // render again with the plan. Both passes happen before the browser paints.
  const [labels, setLabels] = useState<{
    signature: string;
    plan: Map<number, SankeyLabelPlan>;
  }>({ signature: '', plan: new Map() });

  // Node geometry follows the chart's size as well as its data.
  const [viewportSize, setViewportSize] = useState('');
  useEffect(() => {
    if (!viewportEl) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewportSize(`${entry.contentRect.width}x${entry.contentRect.height}`);
    });
    observer.observe(viewportEl);
    return () => observer.disconnect();
  }, [viewportEl]);

  useLayoutEffect(() => {
    if (!viewportEl) return;
    const nodes = readRenderedNodes(viewportEl);
    const signature = JSON.stringify(nodes);
    if (signature === labels.signature) return;
    const measure = measureWith(getComputedStyle(viewportEl).fontFamily);
    setLabels({ signature, plan: planSankeyLabels(nodes, measure) });
  }, [
    viewportEl,
    viewportSize,
    data,
    showPercentages,
    privacyMode,
    labels.signature,
  ]);

  useEffect(() => {
    if (!viewportEl || phase !== 'waiting') return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setPhase('animating');
        observer.disconnect();
      }
    });
    observer.observe(viewportEl);
    return () => observer.disconnect();
  }, [viewportEl, phase]);

  useEffect(() => {
    if (phase !== 'animating') return;
    // 0.3s duration + 0.3s max stagger, plus buffer
    const timer = setTimeout(() => setPhase('done'), 700);
    return () => clearTimeout(timer);
  }, [phase]);

  return (
    <Container
      style={
        growToFit ? { ...style, minHeight: sankeyHeightToFit(data) } : style
      }
    >
      {(width, height) => {
        // recharts sizes nodes as (height - (n - 1) * padding) / total. With a
        // fixed 23px padding a 35-node column needs ~800px of gaps alone; in a
        // shorter chart the scale goes negative and nodes stack on each other
        // or land outside the plot. Keep the gaps to half the inner height.
        const busiest = widestColumn(data);
        const chartHeight = height;
        const chartWidth = width;
        const innerHeight =
          chartHeight - CHART_MARGIN.top - CHART_MARGIN.bottom;
        const nodePadding =
          busiest > 1
            ? Math.max(
                1,
                Math.min(
                  MAX_NODE_PADDING,
                  Math.floor((innerHeight * 0.5) / (busiest - 1)),
                ),
              )
            : MAX_NODE_PADDING;
        return (
          <div
            ref={setViewportEl}
            style={{
              width: '100%',
              height: '100%',
              overflow: 'hidden',
            }}
          >
            <div style={{ width: chartWidth, height: chartHeight }}>
              <ResponsiveContainer>
                <Sankey
                  data={data}
                  node={props => (
                    <SankeyNode
                      {...props}
                      containerWidth={chartWidth}
                      phase={phase}
                      showPercentages={showPercentages}
                      label={labels.plan.get(props.index)}
                    />
                  )}
                  link={props => (
                    <SankeyLink
                      {...props}
                      containerWidth={chartWidth}
                      phase={phase}
                      isHovered={hoveredLinkIndex === props.index}
                      onMouseEnter={() => setHoveredLinkIndex(props.index)}
                      onMouseLeave={() => setHoveredLinkIndex(null)}
                    />
                  )}
                  sort={false}
                  iterations={128}
                  nodePadding={nodePadding}
                  width={chartWidth}
                  height={chartHeight}
                  margin={CHART_MARGIN}
                >
                  {showTooltip && (
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const { value = 0, name = '' } = payload[0];
                        const tooltipInfo =
                          hoveredLinkIndex !== null
                            ? (
                                data.links[hoveredLinkIndex] as {
                                  tooltipInfo?: Array<{
                                    name: string;
                                    value: number;
                                  }>;
                                }
                              )?.tooltipInfo
                            : undefined;
                        return (
                          <div
                            className={css({
                              zIndex: 1000,
                              pointerEvents: 'none',
                              borderRadius: 2,
                              boxShadow: '0 1px 6px rgba(0, 0, 0, .20)',
                              backgroundColor: theme.menuBackground,
                              color: theme.menuItemText,
                              padding: 10,
                            })}
                          >
                            <div style={{ lineHeight: 1.4 }}>
                              {name && (
                                <div style={{ marginBottom: 5 }}>{name}</div>
                              )}
                              <div
                                style={{
                                  fontFamily: privacyMode
                                    ? t('Redacted Script')
                                    : undefined,
                                }}
                              >
                                {format(value, 'financial')}
                              </div>
                              {tooltipInfo && tooltipInfo.length > 0 && (
                                <div
                                  style={{
                                    marginTop: 6,
                                    fontSize: 11,
                                    opacity: 0.7,
                                  }}
                                >
                                  {tooltipInfo.map(item => (
                                    <div key={item.name}>
                                      {item.name} (
                                      <span
                                        style={{
                                          fontFamily: privacyMode
                                            ? t('Redacted Script')
                                            : undefined,
                                        }}
                                      >
                                        {format(item.value, 'financial')}
                                      </span>
                                      )
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      }}
                      isAnimationActive={false}
                    />
                  )}
                </Sankey>
              </ResponsiveContainer>
            </div>
          </div>
        );
      }}
    </Container>
  );
}
