import React from 'react';
import { Box, Paper } from '@mui/material';
import { FormPaper, useFormFactor } from '@proteinjs/ui';
import { Record, Table } from '@proteinjs/db';
import { RecordForm } from '../form/RecordForm';
import { RecordPanel } from './RecordPanel';

export type RecordSurfaceProps<T extends Record> = {
  table: Table<T>;
  record: T;
  /** The visible panels, already resolved and loaded — in render order. */
  panels: RecordPanel<T, any>[];
  /** Each panel's `load()` result, keyed by panel name. */
  panelData: { [panelName: string]: unknown };
  reload: () => Promise<void>;
};

/** The panel column's width beside the form (the mock's 632 + 24 + 480 pair, centered). */
export const RECORD_PANEL_COLUMN_WIDTH_PX = 480;

/**
 * The record form with its declared panels (plans/USAGE_SURFACES.md §B.1). Placement is DERIVED
 * from the viewport, never configured: at `lg` and wider the panels take a column beside the
 * form card; narrower they stack below it, as wide as the form; on phones (the full-bleed form
 * ruling) they stack below the form inside the page's one scroller. The form is the stock
 * `RecordForm` in the stock `FormPaper` — byte-identical to the panel-less page.
 */
export function RecordSurface<T extends Record>({ table, record, panels, panelData, reload }: RecordSurfaceProps<T>) {
  const { isPhone } = useFormFactor();
  const form = <RecordForm table={table} record={record} />;
  const panelCards = panels.map((panel) => {
    const Component = panel.component;
    return (
      <Paper
        key={panel.name}
        data-record-panel={panel.name}
        sx={{ padding: '20px 22px 16px', width: '100%', minWidth: 0, boxSizing: 'border-box' }}
      >
        <Component table={table} record={record} data={panelData[panel.name]} reload={reload} />
      </Paper>
    );
  });

  if (isPhone) {
    return (
      <Box data-phone-fullbleed sx={{ flexGrow: 1, minHeight: 0, width: '100%', overflow: 'auto', padding: 2 }}>
        {form}
        <Box data-record-panels sx={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
          {panelCards}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      data-record-surface
      sx={(theme) => ({
        marginTop: theme.spacing(4),
        marginLeft: 'auto',
        marginRight: 'auto',
        width: 'fit-content',
        maxWidth: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: theme.spacing(3),
        [theme.breakpoints.up('lg')]: {
          flexDirection: 'row',
          alignItems: 'flex-start',
        },
      })}
    >
      <FormPaper>{form}</FormPaper>
      <Box
        data-record-panels
        sx={(theme) => ({
          display: 'flex',
          flexDirection: 'column',
          gap: theme.spacing(3),
          minWidth: 0,
          // Stacked: the column takes the form's width. Inline-size containment keeps the
          // panels' own content out of the fit-content pair's width, so the form card — never
          // a long model name — decides how wide the stack is.
          contain: 'inline-size',
          [theme.breakpoints.up('lg')]: {
            flex: 'none',
            width: RECORD_PANEL_COLUMN_WIDTH_PX,
          },
        })}
      >
        {panelCards}
      </Box>
    </Box>
  );
}
