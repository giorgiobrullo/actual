// @ts-strict-ignore
import { useState, useMemo, type CSSProperties } from 'react';
import { Trans } from 'react-i18next';

import { theme } from '@actual-app/components/theme';
import { css } from '@emotion/css';
import { t } from 'i18next';
import {
  Sankey,
  Tooltip,
  Rectangle,
  Layer,
  ResponsiveContainer,
} from 'recharts';
import { type SankeyData } from 'recharts/types/chart/Sankey';

import { Container } from '@desktop-client/components/reports/Container';
import { useFormat } from '@desktop-client/hooks/useFormat';
import { usePrivacyMode } from '@desktop-client/hooks/usePrivacyMode';
import { useSyncedPref } from '@desktop-client/hooks/useSyncedPref';

// Expense colors - balanced saturation, avoiding green (income) and blue (budget)
// Medium saturation for readability without being garish
const expenseColors = [
  '#E27A3F', // Orange (from qualitative)
  '#9C6ADE', // Purple
  '#DF5A49', // Red (from qualitative)
  '#EFC94C', // Yellow (from qualitative)
  '#E2A37F', // Peach (from qualitative)
  '#D4749D', // Rose
  '#B8860B', // Dark Goldenrod
  '#CD853F', // Peru/Tan
  '#BC6C6C', // Dusty Coral
  '#A57C4A', // Warm Bronze
];

const BUDGET_NODE_NAME = 'Available Funds';

type SankeyTooltipProps = {
  active?: boolean;
  payload?: Array<{
    payload?: {
      source?: SankeyGraphNode;
      target?: SankeyGraphNode;
      value?: number;
      name?: string;
    };
    value?: number;
    name?: string;
  }>;
};

function SankeyCustomTooltip({ active, payload }: SankeyTooltipProps) {
  const format = useFormat();

  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const item = payload[0];
  const value = item.value ?? item.payload?.value ?? 0;
  const name = item.name ?? item.payload?.name ?? '';

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
      <div style={{ lineHeight: 1.5 }}>
        {name && <div style={{ marginBottom: 5 }}>{name}</div>}
        <div>{format(value, 'financial')}</div>
      </div>
    </div>
  );
}

type SankeyGraphNode = SankeyData['nodes'][number] & {
  hasChildren?: boolean;
  isCollapsed?: boolean;
  toBudget?: number;
  nodeType?: 'income' | 'expense' | 'budget';
  isNegative?: boolean;
  isUnderspent?: boolean;
  actualValue?: number;
  colorIndex?: number;
  targetLinks?: Array<Record<string, unknown>>;
  sourceLinks?: Array<Record<string, unknown>>;
};

type SankeyLinkProps = {
  sourceX: number;
  sourceY: number;
  sourceControlX: number;
  targetX: number;
  targetY: number;
  targetControlX: number;
  linkWidth: number;
  index: number;
  payload: {
    source: SankeyGraphNode;
    target: SankeyGraphNode;
    value: number;
    isNegative?: boolean;
    isUnderspent?: boolean;
  };
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
  payload,
  isHovered,
  onMouseEnter,
  onMouseLeave,
}: SankeyLinkProps) {
  // Color links based on node types and negative/underspent status
  let linkColor = theme.reportsGray;
  if (payload.isNegative) {
    // Overspent - red
    linkColor = theme.errorText;
  } else if (payload.isUnderspent) {
    // Underspent (difference mode) - green for positive performance
    linkColor = theme.reportsGreen;
  } else if (payload.source?.nodeType === 'income') {
    linkColor = theme.reportsGreen;
  } else if (payload.target?.name === 'For Next Month') {
    // "For Next Month" is money staying in budget - use budget blue
    linkColor = theme.reportsBlue;
  } else if (payload.target?.nodeType === 'expense') {
    // Links to expense nodes use the target's expense color for visual continuity
    const colorIndex = (payload.target?.colorIndex ?? 0) % expenseColors.length;
    linkColor = expenseColors[colorIndex];
  } else if (payload.source?.nodeType === 'budget') {
    linkColor = theme.reportsBlue;
  }

  // Enhanced styling on hover: thicker stroke and full opacity
  const strokeWidth = isHovered ? linkWidth + 2 : linkWidth;
  const strokeOpacity = isHovered ? 1 : 0.5;

  return (
    <path
      d={`
        M${sourceX},${sourceY}
        C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}
      `}
      fill="none"
      stroke={linkColor}
      strokeWidth={strokeWidth}
      strokeOpacity={strokeOpacity}
      cursor="default"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        transition: 'stroke-opacity 0.2s ease',
      }}
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
  currencyCode: string;
};
function SankeyNode({
  x,
  y,
  width,
  height,
  index,
  payload,
  containerWidth,
}: SankeyNodeProps) {
  const privacyMode = usePrivacyMode();
  const nodeLabel = payload.name;
  const format = useFormat();

  // Leaf nodes have no outgoing links - always show text on the right
  const isLeaf = !payload.sourceLinks || payload.sourceLinks.length === 0;
  // For non-leaf nodes near the right edge, show text on the left
  const isOut = !isLeaf && x + width + 6 > containerWidth;

  // Color nodes based on their type and performance status
  let fillColor = theme.reportsBlue;
  if (payload.isNegative) {
    // Overspent - red
    fillColor = theme.errorText;
  } else if (payload.isUnderspent) {
    // Underspent (difference mode) - green for positive performance
    fillColor = theme.reportsGreen;
  } else if (payload.nodeType === 'income') {
    fillColor = theme.reportsGreen;
  } else if (payload.nodeType === 'budget') {
    fillColor = theme.reportsBlue;
  } else if (payload.name === 'For Next Month') {
    // "For Next Month" is money staying in budget, not an expense - use budget blue
    fillColor = theme.reportsBlue;
  } else if (payload.nodeType === 'expense') {
    // Use sequential colors for expense categories
    const colorIndex = (payload.colorIndex ?? 0) % expenseColors.length;
    fillColor = expenseColors[colorIndex];
  }
  const fillOpacity = 1;

  // Use actualValue if available (for difference view with zero values), otherwise use payload.value
  const displayValue =
    payload.actualValue !== undefined
      ? Math.abs(payload.actualValue)
      : payload.value;

  // Check if this is the Budget node with unallocated funds
  const isBudgetNode = payload.name === BUDGET_NODE_NAME;
  const hasToBudget = isBudgetNode && payload.toBudget && payload.toBudget > 0;

  // Calculate the position for "To Budget" label in the unallocated portion
  let toBudgetLabelY = y + height / 2 + 26; // Default position
  if (hasToBudget && payload.value > 0) {
    // Calculate what proportion of the node is allocated vs unallocated
    const totalValue = payload.value;
    const allocatedValue = totalValue - (payload.toBudget || 0);
    const allocatedRatio = allocatedValue / totalValue;

    // The allocated portion takes up allocatedRatio * height
    // Position the label in the middle of the remaining (unallocated) portion
    const allocatedHeight = height * allocatedRatio;
    const unallocatedHeight = height - allocatedHeight;
    toBudgetLabelY = y + allocatedHeight + unallocatedHeight / 2;
  }

  // Calculate allocated and unallocated heights for Budget node with two-tone coloring
  let allocatedHeight = height;
  let unallocatedHeight = 0;
  if (hasToBudget && payload.value > 0) {
    const totalValue = payload.value;
    const allocatedValue = totalValue - (payload.toBudget || 0);
    const allocatedRatio = allocatedValue / totalValue;
    allocatedHeight = height * allocatedRatio;
    unallocatedHeight = height - allocatedHeight;
  }

  return (
    <Layer key={`CustomNode${index}`}>
      {/* For Budget node with unallocated funds, draw two rectangles */}
      {hasToBudget ? (
        <>
          {/* Allocated portion (top) - blue */}
          <Rectangle
            x={x}
            y={y}
            width={width}
            height={allocatedHeight}
            fill={fillColor}
            fillOpacity={fillOpacity}
          />
          {/* Unallocated portion (bottom) - yellow */}
          <Rectangle
            x={x}
            y={y + allocatedHeight}
            width={width}
            height={unallocatedHeight}
            fill={theme.warningText}
            fillOpacity={0.5}
          />
          <text
            textAnchor={isOut ? 'end' : 'start'}
            x={isOut ? x - 6 : x + width + 6}
            y={y + allocatedHeight / 2}
            fontSize="13"
            fill={theme.pageText}
          >
            <Trans>Budgeted</Trans>
          </text>
          <text
            textAnchor={isOut ? 'end' : 'start'}
            x={isOut ? x - 6 : x + width + 6}
            y={y + allocatedHeight / 2 + 13}
            fontSize="11"
            strokeOpacity="0.5"
            fill={theme.pageText}
            fontFamily={privacyMode ? t('Redacted Script') : undefined}
          >
            {format(payload.value - (payload.toBudget || 0), 'financial')}
          </text>
          <text
            textAnchor={isOut ? 'end' : 'start'}
            x={isOut ? x - 6 : x + width + 6}
            y={toBudgetLabelY}
            fontSize="13"
            fill={theme.pageText}
          >
            <Trans>To Budget</Trans>
          </text>
          <text
            textAnchor={isOut ? 'end' : 'start'}
            x={isOut ? x - 6 : x + width + 6}
            y={toBudgetLabelY + 13}
            fontSize="11"
            strokeOpacity="1"
            fill={theme.pageText}
            fontFamily={privacyMode ? t('Redacted Script') : undefined}
          >
            {format(payload.toBudget, 'financial')}
          </text>
        </>
      ) : (
        /* Regular single-color rectangle for all other nodes */
        <>
          <Rectangle
            x={x}
            y={y}
            width={width}
            height={height}
            fill={fillColor}
            fillOpacity={fillOpacity}
          />
          <text
            textAnchor={isOut ? 'end' : 'start'}
            x={isOut ? x - 6 : x + width + 6}
            y={y + height / 2}
            fontSize="13"
            fill={theme.pageText}
          >
            {nodeLabel}
          </text>
          <text
            textAnchor={isOut ? 'end' : 'start'}
            x={isOut ? x - 6 : x + width + 6}
            y={y + height / 2 + 13}
            fontSize="11"
            strokeOpacity="0.5"
            fill={theme.pageText}
            fontFamily={privacyMode ? t('Redacted Script') : undefined}
          >
            {format(displayValue, 'financial')}
          </text>
        </>
      )}
    </Layer>
  );
}

function convertToCondensed(data: SankeyData) {
  const budgetNodeIndex = data.nodes.findIndex(
    node => node.name === BUDGET_NODE_NAME,
  );

  // If no budget node found, return empty data
  if (budgetNodeIndex === -1) {
    return { nodes: [], links: [] };
  }

  // Calculate total income (links going into the "Budget" node)
  const totalIncome = data.links.reduce((acc, link) => {
    return link.target === budgetNodeIndex ? acc + link.value : acc;
  }, 0);

  // Calculate total expenses (links going out of the "Budget" node)
  const totalExpenses = data.links.reduce((acc, link) => {
    return link.source === budgetNodeIndex ? acc + link.value : acc;
  }, 0);

  // If no income and no expenses, return empty data
  if (totalIncome === 0 && totalExpenses === 0) {
    return { nodes: [], links: [] };
  }

  const nodes = [{ name: BUDGET_NODE_NAME }];
  const links: Array<{ source: number; target: number; value: number }> = [];

  // Only add income node and link if there's income
  if (totalIncome > 0) {
    nodes.unshift({ name: 'Income' });
    links.push({ source: 0, target: 1, value: totalIncome });
  }

  // Only add expenses node and link if there are expenses
  if (totalExpenses > 0) {
    const budgetIndex = totalIncome > 0 ? 1 : 0;
    nodes.push({ name: 'Expenses' });
    links.push({
      source: budgetIndex,
      target: nodes.length - 1,
      value: totalExpenses,
    });
  }

  return { nodes, links };
}

type SankeyGraphProps = {
  style?: CSSProperties;
  data: SankeyData;
  compact?: boolean;
  showTooltip?: boolean;
  collapsedNodes?: string[];
};
export function SankeyGraph({
  style,
  data,
  compact = false,
  showTooltip = true,
  collapsedNodes = [],
}: SankeyGraphProps) {
  const [defaultCurrencyCode] = useSyncedPref('defaultCurrencyCode');
  const currencyCode = defaultCurrencyCode || 'USD';
  const [hoveredLinkIndex, setHoveredLinkIndex] = useState<number | null>(null);

  const collapsedSet = useMemo(() => new Set(collapsedNodes), [collapsedNodes]);
  const sankeyData = useMemo(() => {
    if (compact) {
      return convertToCondensed(data);
    }
    return collapseSankeyBranches(data, collapsedSet);
  }, [compact, data, collapsedSet]);

  // Count leaf nodes (nodes with no outgoing links) to determine required height
  // Each leaf node needs ~35px (label + padding) to display properly
  const leafNodeCount = useMemo(() => {
    if (!sankeyData.nodes || !sankeyData.links) return 0;
    const nodesWithOutgoing = new Set(sankeyData.links.map(l => l.source));
    return sankeyData.nodes.filter((_, idx) => !nodesWithOutgoing.has(idx))
      .length;
  }, [sankeyData]);

  // Calculate minimum height: ensure each leaf node gets enough space
  // Base height of 300, but scale up if we have many leaf nodes
  const dynamicMinHeight = useMemo(() => {
    if (compact) return 300;
    const heightPerNode = 42; // Enough for label + value + comfortable padding
    const minForLeafs = leafNodeCount * heightPerNode;
    return Math.max(300, minForLeafs);
  }, [compact, leafNodeCount]);

  if (!sankeyData.links || sankeyData.links.length === 0) {
    return (
      <Container
        style={{ ...style, minHeight: compact ? 300 : dynamicMinHeight }}
      >
        {() => (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: theme.pageTextSubdued,
              fontSize: compact ? 12 : 14,
            }}
          >
            <Trans>No data to display</Trans>
          </div>
        )}
      </Container>
    );
  }

  return (
    <Container style={{ ...style, minHeight: dynamicMinHeight }}>
      {(width, height) => (
        <ResponsiveContainer>
          <Sankey
            data={sankeyData}
            node={props => (
              <SankeyNode
                {...props}
                containerWidth={width}
                currencyCode={currencyCode}
              />
            )}
            link={props => (
              <SankeyLink
                {...props}
                isHovered={hoveredLinkIndex === props.index}
                onMouseEnter={() => setHoveredLinkIndex(props.index)}
                onMouseLeave={() => setHoveredLinkIndex(null)}
              />
            )}
            sort={false}
            iterations={1000}
            nodePadding={23}
            width={width}
            height={height}
            margin={{
              left: 0,
              right: compact ? 80 : 120,
              top: compact ? 0 : 10,
              bottom: compact ? 0 : 25,
            }}
          >
            {showTooltip && (
              <Tooltip
                content={<SankeyCustomTooltip />}
                isAnimationActive={false}
              />
            )}
          </Sankey>
        </ResponsiveContainer>
      )}
    </Container>
  );
}

function collapseSankeyBranches(
  data: SankeyData,
  collapsedNodes: Set<string>,
): SankeyData {
  const nameToIndex = new Map<string, number>();
  data.nodes.forEach((node, index) => {
    if (typeof node.name === 'string') {
      nameToIndex.set(node.name, index);
    }
  });

  // Build map of parent to children based on links
  const childrenByParent = new Map<number, Set<number>>();
  data.links.forEach(link => {
    const sourceIndex = normalizeIndex(link.source, nameToIndex);
    const targetIndex = normalizeIndex(link.target, nameToIndex);
    if (sourceIndex !== null && targetIndex !== null) {
      if (!childrenByParent.has(sourceIndex)) {
        childrenByParent.set(sourceIndex, new Set());
      }
      childrenByParent.get(sourceIndex)!.add(targetIndex);
    }
  });

  // Find collapsed parent indexes
  const collapsedIndexes = new Set<number>();
  collapsedNodes.forEach(name => {
    const index = nameToIndex.get(name);
    if (index !== undefined && data.nodes[index]?.name !== BUDGET_NODE_NAME) {
      collapsedIndexes.add(index);
    }
  });

  // Find all children of collapsed parents (recursively)
  const hiddenIndexes = new Set<number>();
  const findAllChildren = (parentIndex: number) => {
    const children = childrenByParent.get(parentIndex);
    if (children) {
      children.forEach(childIndex => {
        hiddenIndexes.add(childIndex);
        findAllChildren(childIndex);
      });
    }
  };
  collapsedIndexes.forEach(index => findAllChildren(index));

  // Filter links that involve hidden children
  const filteredLinks = data.links.filter(link => {
    const sourceIndex = normalizeIndex(link.source, nameToIndex);
    const targetIndex = normalizeIndex(link.target, nameToIndex);
    if (sourceIndex === null || targetIndex === null) {
      return false;
    }
    return !hiddenIndexes.has(sourceIndex) && !hiddenIndexes.has(targetIndex);
  });

  // Determine which nodes to keep
  const usedIndexes = new Set<number>();
  filteredLinks.forEach(link => {
    const sourceIndex = normalizeIndex(link.source, nameToIndex);
    const targetIndex = normalizeIndex(link.target, nameToIndex);
    if (sourceIndex !== null) usedIndexes.add(sourceIndex);
    if (targetIndex !== null) usedIndexes.add(targetIndex);
  });

  // Always include Available Funds node
  const budgetIndex = nameToIndex.get(BUDGET_NODE_NAME);
  if (budgetIndex !== undefined) {
    usedIndexes.add(budgetIndex);
  }

  // Build new node list
  const nodesWithIndex = data.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ index }) => usedIndexes.has(index));

  const indexMap = new Map<number, number>();
  const nodes = nodesWithIndex.map(({ node, index }, newIndex) => {
    indexMap.set(index, newIndex);
    return {
      ...node,
      hasChildren:
        childrenByParent.has(index) && childrenByParent.get(index)!.size > 0,
      isCollapsed: collapsedIndexes.has(index),
    };
  });

  // Remap links
  const links = filteredLinks
    .map(link => {
      const sourceIndex = normalizeIndex(link.source, nameToIndex);
      const targetIndex = normalizeIndex(link.target, nameToIndex);
      if (sourceIndex === null || targetIndex === null) {
        return null;
      }
      const mappedSource = indexMap.get(sourceIndex);
      const mappedTarget = indexMap.get(targetIndex);
      if (mappedSource === undefined || mappedTarget === undefined) {
        return null;
      }
      return {
        ...link,
        source: mappedSource,
        target: mappedTarget,
      };
    })
    .filter((link): link is SankeyData['links'][number] => link !== null);

  return { nodes, links };
}

function normalizeIndex(
  value: number | string,
  nameToIndex: Map<string, number>,
): number | null {
  if (typeof value === 'number') {
    return value;
  }
  const index = nameToIndex.get(value);
  return index ?? null;
}
