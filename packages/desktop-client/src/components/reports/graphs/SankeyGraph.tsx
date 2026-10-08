import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

import { theme } from '@actual-app/components/theme';
import { css, keyframes } from '@emotion/css';
import { t } from 'i18next';
import {
  Layer,
  Rectangle,
  ResponsiveContainer,
  Sankey,
  Tooltip,
} from 'recharts';
import type { SankeyData } from 'recharts/types/chart/Sankey';

import { Container } from '#components/reports/Container';
import { useFormat } from '#hooks/useFormat';
import { usePrivacyMode } from '#hooks/usePrivacyMode';
import { useReducedMotion } from '#hooks/useReducedMotion';

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
  const strokeWidth = linkWidth;
  const strokeOpacity = isHovered ? 1 : 0.6;
  // use the link's midpoint so it eases in with the columns it spans
  const fraction = (sourceX + targetX) / 2 / containerWidth;

  return (
    <path
      className={
        reducedMotion || phase === 'done'
          ? undefined
          : phase === 'animating'
            ? fadeInClass(fraction)
            : hiddenClass
      }
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={linkColor}
      strokeWidth={strokeWidth}
      strokeOpacity={strokeOpacity}
      cursor="default"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ transition: 'stroke-opacity 0.2s ease' }}
    />
  );
}

// Vertical intervals already occupied by labels, per column. Rebuilt on every
// chart render; nodes consult it to decide whether their second text line has
// room, so the decision tracks the actual space below a node rather than the
// node's own height — a 3px node with nothing under it can carry its amount.
type LabelRegistry = Map<number, Array<[number, number]>>;

type SankeyNodeProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  payload: SankeyGraphNode;
  containerWidth: number;
  phase: 'waiting' | 'animating' | 'done';
  showPercentages?: boolean;
  color?: string;
  labelRegistry: LabelRegistry;
};
function SankeyNode({
  x,
  y,
  width,
  height,
  payload,
  containerWidth,
  phase,
  showPercentages,
  labelRegistry,
}: SankeyNodeProps) {
  const privacyMode = usePrivacyMode();
  const format = useFormat();
  const reducedMotion = useReducedMotion();

  if (payload.value <= 0) {
    return null;
  }
  const isOut = x + width + 6 > containerWidth;

  const fillColor = payload.color ?? theme.reportsBlue;

  const renderText = (
    text: string,
    yOffset: number,
    fontSize = 13,
    opacity = 1,
    fontFamily?: string,
    yBase = y,
  ) => (
    <text
      textAnchor={isOut ? 'end' : 'start'}
      x={isOut ? x - 6 : x + width + 6}
      y={yBase + yOffset}
      fontSize={fontSize}
      strokeOpacity={opacity}
      fill={theme.pageText}
      fontFamily={fontFamily}
    >
      {text}
    </text>
  );

  // Two 13px/11px text lines hang from the node's vertical middle. Whether
  // they fit is a question about the neighbours' labels in the same column,
  // not about this node's height. Check the space already claimed: the amount
  // line goes first, and the name too when it would overprint a neighbour's
  // (a dense column otherwise turned into unreadable stacked text). A node
  // without a label still shows its name and amount in the tooltip.
  const NAME_ASCENT = 10;
  const NAME_DESCENT = 3;
  const VALUE_DESCENT = 3;
  const middle = y + height / 2;
  const nameTop = middle - NAME_ASCENT;
  const nameBottom = middle + NAME_DESCENT;
  const valueBottom = middle + 13 + VALUE_DESCENT;

  const columnKey = Math.round(x);
  const occupied = labelRegistry.get(columnKey) ?? [];
  const overlaps = (top: number, bottom: number) =>
    occupied.some(([t, b]) => top < b && bottom > t);

  const showName = !overlaps(nameTop, nameBottom);
  const showValueLine = showName && !overlaps(nameTop, valueBottom);
  if (showName) {
    occupied.push([nameTop, showValueLine ? valueBottom : nameBottom]);
    labelRegistry.set(columnKey, occupied);
  }

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
      <Rectangle x={x} y={y} width={width} height={height} fill={fillColor} />
      {showName && renderText(payload.name || '', height / 2)}
      {showValueLine &&
        renderText(
          showPercentages && payload.percentageLabel
            ? payload.percentageLabel
            : format(payload.value, 'financial'),
          height / 2 + 13,
          11,
          0.5,
          privacyMode ? t('Redacted Script') : undefined,
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

type SankeyGraphProps = {
  style?: CSSProperties;
  data: SankeyData;
  showTooltip?: boolean;
  showPercentages?: boolean;
  // Render fully visible from the first frame. The load animation gates on an
  // IntersectionObserver, which never fires for the offscreen copy the image
  // export draws — without this, the exported PNG would be blank.
  animationDisabled?: boolean;
  // Grow taller than the container (scrolling) when the busiest column needs
  // more room, instead of squeezing every node into the available height.
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

  // Fresh per render: recharts draws all nodes in one synchronous pass, and
  // each node registers the label space it takes as it renders.
  const labelRegistry: LabelRegistry = new Map();

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
    <Container style={style}>
      {(width, height) => {
        // recharts sizes nodes as (height - (n - 1) * padding) / total. With a
        // fixed 23px padding a 35-node column needs ~800px of gaps alone; in a
        // shorter chart the scale goes negative and nodes stack on each other
        // or land outside the plot. Keep the gaps to half the inner height.
        const busiest = widestColumn(data);
        const chartHeight = growToFit
          ? Math.max(
              height,
              busiest * PX_PER_NODE_TO_FIT +
                CHART_MARGIN.top +
                CHART_MARGIN.bottom,
            )
          : height;
        const scrolls = chartHeight > height;
        const chartWidth = scrolls ? Math.max(0, width - 16) : width;
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
              overflowY: scrolls ? 'auto' : 'hidden',
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
                      labelRegistry={labelRegistry}
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
