import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { View } from '@actual-app/components/view';

import { type SankeyWidget } from 'loot-core/types/models';

import { DateRange } from '@desktop-client/components/reports/DateRange';
import { SankeyGraph } from '@desktop-client/components/reports/graphs/SankeyGraph';
import { LoadingIndicator } from '@desktop-client/components/reports/LoadingIndicator';
import { ReportCard } from '@desktop-client/components/reports/ReportCard';
import { ReportCardName } from '@desktop-client/components/reports/ReportCardName';
import { calculateTimeRange } from '@desktop-client/components/reports/reportRanges';
import { createSpreadsheet as sankeySpreadsheet } from '@desktop-client/components/reports/spreadsheets/sankey-spreadsheet';
import { useReport } from '@desktop-client/components/reports/useReport';
import { useWidgetCopyMenu } from '@desktop-client/components/reports/useWidgetCopyMenu';
import { useCategories } from '@desktop-client/hooks/useCategories';

type SankeyCardProps = {
  widgetId: string;
  isEditing?: boolean;
  meta?: SankeyWidget['meta'];
  onMetaChange: (newMeta: SankeyWidget['meta']) => void;
  onRemove: () => void;
  onCopy: (targetDashboardId: string) => void;
};
export function SankeyCard({
  widgetId,
  isEditing,
  meta,
  onMetaChange,
  onRemove,
  onCopy,
}: SankeyCardProps) {
  const { t } = useTranslation();
  const [nameMenuOpen, setNameMenuOpen] = useState(false);
  const categories = useCategories();

  const { menuItems: copyMenuItems, handleMenuSelect: handleCopyMenuSelect } =
    useWidgetCopyMenu(onCopy);

  const [start, end] = calculateTimeRange(meta?.timeFrame);
  const mode = meta?.mode ?? 'budgeted';

  const params = useMemo(
    () =>
      sankeySpreadsheet(
        start,
        end,
        categories.grouped,
        meta?.conditions ?? [],
        meta?.conditionsOp ?? 'and',
        mode,
      ),
    [
      start,
      end,
      categories.grouped,
      meta?.conditions,
      meta?.conditionsOp,
      mode,
    ],
  );
  const data = useReport('sankey', params);

  return (
    <ReportCard
      isEditing={isEditing}
      disableClick={nameMenuOpen}
      to={`/reports/sankey/${widgetId}`}
      menuItems={[
        {
          name: 'rename',
          text: t('Rename'),
        },
        ...copyMenuItems,
        {
          name: 'remove',
          text: t('Remove'),
        },
      ]}
      onMenuSelect={item => {
        if (handleCopyMenuSelect(item)) {
          return;
        }
        switch (item) {
          case 'rename':
            setNameMenuOpen(true);
            break;
          case 'remove':
            onRemove();
            break;
          default:
            throw new Error(`Unrecognized selection: ${item}`);
        }
      }}
    >
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', padding: 20 }}>
          <View style={{ flex: 1 }}>
            <ReportCardName
              name={meta?.name || t('Sankey')}
              isEditing={nameMenuOpen}
              onChange={newName => {
                onMetaChange({
                  ...meta,
                  name: newName,
                });
                setNameMenuOpen(false);
              }}
              onClose={() => setNameMenuOpen(false)}
            />
            <DateRange start={start} end={end} />
          </View>
        </View>

        {data ? (
          <SankeyGraph data={data} compact showTooltip={!isEditing} />
        ) : (
          <LoadingIndicator />
        )}
      </View>
    </ReportCard>
  );
}
