import { useEffect, useMemo, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useParams } from 'react-router';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { Paragraph } from '@actual-app/components/paragraph';
import { SpaceBetween } from '@actual-app/components/space-between';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import * as d from 'date-fns';
import { type SankeyData } from 'recharts/types/chart/Sankey';

import { send } from 'loot-core/platform/client/fetch';
import * as monthUtils from 'loot-core/shared/months';
import {
  type SankeyWidget,
  type RuleConditionEntity,
  type TimeFrame,
} from 'loot-core/types/models';

import { EditablePageHeaderTitle } from '@desktop-client/components/EditablePageHeaderTitle';
import { MobileBackButton } from '@desktop-client/components/mobile/MobileBackButton';
import {
  MobilePageHeader,
  Page,
  PageHeader,
} from '@desktop-client/components/Page';
import { SankeyGraph } from '@desktop-client/components/reports/graphs/SankeyGraph';
import { Header } from '@desktop-client/components/reports/Header';
import { LoadingIndicator } from '@desktop-client/components/reports/LoadingIndicator';
import { ModeButton } from '@desktop-client/components/reports/ModeButton';
import { calculateTimeRange } from '@desktop-client/components/reports/reportRanges';
import { createSpreadsheet as sankeySpreadsheet } from '@desktop-client/components/reports/spreadsheets/sankey-spreadsheet';
import { useReport } from '@desktop-client/components/reports/useReport';
import { fromDateRepr } from '@desktop-client/components/reports/util';
import { useCategories } from '@desktop-client/hooks/useCategories';
import { useLocale } from '@desktop-client/hooks/useLocale';
import { useNavigate } from '@desktop-client/hooks/useNavigate';
import { useRuleConditionFilters } from '@desktop-client/hooks/useRuleConditionFilters';
import { useWidget } from '@desktop-client/hooks/useWidget';
import { addNotification } from '@desktop-client/notifications/notificationsSlice';
import { useDispatch } from '@desktop-client/redux';

export function Sankey() {
  const params = useParams();
  const { data: widget, isLoading } = useWidget<SankeyWidget>(
    params.id ?? '',
    'sankey-card',
  );

  if (isLoading) {
    return <LoadingIndicator />;
  }

  return <SankeyInner widget={widget} />;
}

type SankeyInnerProps = {
  widget?: SankeyWidget;
};

function SankeyInner({ widget }: SankeyInnerProps) {
  const locale = useLocale();
  const dispatch = useDispatch();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isNarrowWidth } = useResponsive();

  const {
    conditions,
    conditionsOp,
    onApply: onApplyFilter,
    onDelete: onDeleteFilter,
    onUpdate: onUpdateFilter,
    onConditionsOpChange,
  } = useRuleConditionFilters<RuleConditionEntity>(
    widget?.meta?.conditions,
    widget?.meta?.conditionsOp,
  );

  const [allMonths, setAllMonths] = useState<Array<{
    name: string;
    pretty: string;
  }> | null>(null);

  const [start, setStart] = useState(monthUtils.currentMonth());
  const [end, setEnd] = useState(monthUtils.currentMonth());
  const [timeFrameMode, setTimeFrameMode] =
    useState<TimeFrame['mode']>('sliding-window');

  const [earliestTransaction, setEarliestTransaction] = useState('');
  const [latestTransaction, setLatestTransaction] = useState('');

  const initialMode = widget?.meta?.mode ?? 'budgeted';
  const [mode, setMode] = useState<'budgeted' | 'spent' | 'difference'>(
    initialMode,
  );

  const [compact, setCompact] = useState(widget?.meta?.compact ?? true);
  const [grouped, setGrouped] = useState(widget?.meta?.grouped ?? true);
  const [sortBy, setSortBy] = useState<'category' | 'value' | 'alphabetical'>(
    widget?.meta?.sortBy ?? 'category',
  );

  const categories = useCategories();

  const reportParams = useMemo(
    () =>
      sankeySpreadsheet(
        start,
        end,
        categories.grouped,
        conditions,
        conditionsOp,
        mode,
        grouped,
        sortBy,
      ),
    [start, end, categories, conditions, conditionsOp, mode, grouped, sortBy],
  );
  const data = useReport('sankey', reportParams);

  useEffect(() => {
    async function run() {
      const earliestTrans = await send('get-earliest-transaction');
      const latestTrans = await send('get-latest-transaction');

      setEarliestTransaction(
        earliestTrans ? earliestTrans.date : monthUtils.currentDay(),
      );
      setLatestTransaction(
        latestTrans ? latestTrans.date : monthUtils.currentDay(),
      );

      const currentMonth = monthUtils.currentMonth();
      let earliestMonth = earliestTrans
        ? monthUtils.monthFromDate(d.parseISO(fromDateRepr(earliestTrans.date)))
        : currentMonth;
      const latestTransactionMonth = latestTrans
        ? monthUtils.monthFromDate(d.parseISO(fromDateRepr(latestTrans.date)))
        : currentMonth;

      const latestMonth =
        latestTransactionMonth > currentMonth
          ? latestTransactionMonth
          : currentMonth;

      const yearAgo = monthUtils.subMonths(latestMonth, 12);
      if (earliestMonth > yearAgo) {
        earliestMonth = yearAgo;
      }

      const allMonths = monthUtils
        .rangeInclusive(earliestMonth, latestMonth)
        .map(month => ({
          name: month,
          pretty: monthUtils.format(month, 'MMMM, yyyy', locale),
        }))
        .reverse();

      setAllMonths(allMonths);
    }
    run();
  }, [locale]);

  useEffect(() => {
    if (latestTransaction) {
      const [initialStart, initialEnd, initialMode] = calculateTimeRange(
        widget?.meta?.timeFrame,
        undefined,
        latestTransaction,
      );
      setStart(initialStart);
      setEnd(initialEnd);
      setTimeFrameMode(initialMode);
    }
  }, [latestTransaction, widget?.meta?.timeFrame]);

  function onChangeDates(start: string, end: string, mode: TimeFrame['mode']) {
    setStart(start);
    setEnd(end);
    setTimeFrameMode(mode);
  }

  async function onSaveWidget() {
    if (!widget) {
      throw new Error('No widget that could be saved.');
    }

    await send('dashboard-update-widget', {
      id: widget.id,
      meta: {
        ...(widget.meta ?? {}),
        conditions,
        conditionsOp,
        mode,
        compact,
        grouped,
        sortBy,
        timeFrame: {
          start,
          end,
          mode: timeFrameMode,
        },
      },
    });
    dispatch(
      addNotification({
        notification: {
          type: 'message',
          message: t('Dashboard widget successfully saved.'),
        },
      }),
    );
  }

  const onSaveWidgetName = async (newName: string) => {
    if (!widget) {
      throw new Error('No widget that could be saved.');
    }

    const name = newName || t('Sankey');
    await send('dashboard-update-widget', {
      id: widget.id,
      meta: {
        ...(widget.meta ?? {}),
        name,
      },
    });
  };

  const title = widget?.meta?.name || t('Sankey');

  if (!allMonths || !data) {
    return null;
  }

  return (
    <Page
      header={
        isNarrowWidth ? (
          <MobilePageHeader
            title={title}
            leftContent={
              <MobileBackButton onPress={() => navigate('/reports')} />
            }
          />
        ) : (
          <PageHeader
            title={
              widget ? (
                <EditablePageHeaderTitle
                  title={title}
                  onSave={onSaveWidgetName}
                />
              ) : (
                title
              )
            }
          />
        )
      }
      padding={0}
    >
      <Header
        allMonths={allMonths}
        start={start}
        end={end}
        earliestTransaction={earliestTransaction}
        latestTransaction={latestTransaction}
        mode={timeFrameMode}
        onChangeDates={onChangeDates}
        filters={conditions}
        onApply={onApplyFilter}
        onUpdateFilter={onUpdateFilter}
        onDeleteFilter={onDeleteFilter}
        conditionsOp={conditionsOp}
        onConditionsOpChange={onConditionsOpChange}
        show1Month
        inlineContent={
          !isNarrowWidth && (
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: 20 }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Text style={{ fontWeight: 500, color: theme.pageText }}>
                  <Trans>Show as</Trans>
                </Text>
                <SpaceBetween gap={5}>
                  <ModeButton
                    selected={mode === 'budgeted'}
                    onSelect={() => setMode('budgeted')}
                    style={{ backgroundColor: 'inherit' }}
                  >
                    <Trans>Budgeted</Trans>
                  </ModeButton>
                  <ModeButton
                    selected={mode === 'spent'}
                    style={{ backgroundColor: 'inherit' }}
                    onSelect={() => setMode('spent')}
                  >
                    <Trans>Spent</Trans>
                  </ModeButton>
                  <ModeButton
                    selected={mode === 'difference'}
                    style={{ backgroundColor: 'inherit' }}
                    onSelect={() => setMode('difference')}
                  >
                    <Trans>Difference</Trans>
                  </ModeButton>
                </SpaceBetween>
              </View>
              <View
                style={{
                  width: 1,
                  height: 20,
                  backgroundColor: theme.tableBorder,
                }}
              />
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Text style={{ fontWeight: 500, color: theme.pageText }}>
                  <Trans>Categories</Trans>
                </Text>
                <SpaceBetween gap={5}>
                  <ModeButton
                    selected={grouped}
                    onSelect={() => setGrouped(true)}
                    style={{ backgroundColor: 'inherit' }}
                  >
                    <Trans>Grouped</Trans>
                  </ModeButton>
                  <ModeButton
                    selected={!grouped}
                    onSelect={() => setGrouped(false)}
                    style={{ backgroundColor: 'inherit' }}
                  >
                    <Trans>Flat</Trans>
                  </ModeButton>
                </SpaceBetween>
              </View>
              <View
                style={{
                  width: 1,
                  height: 20,
                  backgroundColor: theme.tableBorder,
                }}
              />
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Text style={{ fontWeight: 500, color: theme.pageText }}>
                  <Trans>Card view</Trans>
                </Text>
                <SpaceBetween gap={5}>
                  <ModeButton
                    selected={compact}
                    onSelect={() => setCompact(true)}
                    style={{ backgroundColor: 'inherit' }}
                  >
                    <Trans>Compact</Trans>
                  </ModeButton>
                  <ModeButton
                    selected={!compact}
                    onSelect={() => setCompact(false)}
                    style={{ backgroundColor: 'inherit' }}
                  >
                    <Trans>Full</Trans>
                  </ModeButton>
                </SpaceBetween>
              </View>
              <View
                style={{
                  width: 1,
                  height: 20,
                  backgroundColor: theme.tableBorder,
                }}
              />
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Text style={{ fontWeight: 500, color: theme.pageText }}>
                  <Trans>Sort</Trans>
                </Text>
                <SpaceBetween gap={5}>
                  <ModeButton
                    selected={sortBy === 'category'}
                    onSelect={() => setSortBy('category')}
                    style={{ backgroundColor: 'inherit' }}
                  >
                    <Trans>Category</Trans>
                  </ModeButton>
                  <ModeButton
                    selected={sortBy === 'value'}
                    onSelect={() => setSortBy('value')}
                    style={{ backgroundColor: 'inherit' }}
                  >
                    <Trans>Value</Trans>
                  </ModeButton>
                  <ModeButton
                    selected={sortBy === 'alphabetical'}
                    onSelect={() => setSortBy('alphabetical')}
                    style={{ backgroundColor: 'inherit' }}
                  >
                    <Trans>A-Z</Trans>
                  </ModeButton>
                </SpaceBetween>
              </View>
            </View>
          )
        }
      >
        {widget && (
          <Button variant="primary" onPress={onSaveWidget}>
            <Trans>Save widget</Trans>
          </Button>
        )}
      </Header>

      <View
        style={{
          display: 'flex',
          flexDirection: 'row',
          paddingTop: 0,
          flexGrow: 1,
        }}
      >
        <View
          style={{
            flexGrow: 1,
          }}
        >
          <View
            style={{
              backgroundColor: theme.tableBackground,
              padding: 20,
              paddingTop: 0,
              flex: '1 0 auto',
              overflowY: 'auto',
            }}
          >
            <View
              style={{
                flexDirection: 'column',
                flexGrow: 1,
                padding: 10,
                paddingTop: 10,
              }}
            >
              {data && data.links && data.links.length > 0 ? (
                <SankeyGraph
                  style={{ flexGrow: 1 }}
                  data={data as SankeyData}
                  compact={compact}
                />
              ) : (
                <View
                  style={{
                    flexGrow: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: theme.pageText,
                  }}
                >
                  <Text style={{ fontSize: 16, textAlign: 'center' }}>
                    {mode === 'budgeted' && (
                      <Trans>
                        No data available for this period. Try budgeting
                        categories or selecting a different date range.
                      </Trans>
                    )}
                    {mode === 'spent' && (
                      <Trans>
                        No data available for this period. Try adding
                        transactions or selecting a different date range.
                      </Trans>
                    )}
                    {mode === 'difference' && (
                      <Trans>
                        No data available for this period. Try budgeting or
                        adding transactions, or selecting a different date
                        range.
                      </Trans>
                    )}
                  </Text>
                </View>
              )}

              <View style={{ marginTop: 30 }}>
                <Trans>
                  <Paragraph>
                    <strong>What is a Sankey plot?</strong>
                  </Paragraph>
                  <Paragraph>
                    A Sankey plot visualizes the flow of quantities between
                    multiple categories, emphasizing the distribution and
                    proportional relationships of data streams.
                  </Paragraph>
                  <Paragraph>
                    <strong>View options:</strong>
                  </Paragraph>
                  <ul style={{ marginTop: 0, paddingLeft: 20 }}>
                    <li style={{ marginBottom: 5 }}>
                      <strong>Budgeted:</strong> Shows how income flows into
                      your budget and is allocated across categories.
                    </li>
                    <li style={{ marginBottom: 5 }}>
                      <strong>Spent:</strong> Displays actual spending by
                      category from transactions.
                    </li>
                    <li>
                      <strong>Difference:</strong> Highlights budget vs. actual
                      variance, showing overspent categories in red and
                      underspent categories in green.
                    </li>
                  </ul>
                </Trans>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Page>
  );
}
