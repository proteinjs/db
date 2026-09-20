import React from 'react';
import { Box, Typography } from '@mui/material';
import { ClampedTextCellValue, EmptyCellValue, useFormFactor } from '@proteinjs/ui';
import { RecordTableRowChip } from './RecordTableCustomization';

export type IdentityCellValueProps = {
  value: unknown;
  /** The column's own presentation of the value, when it has one; plain text otherwise. */
  rendered?: React.ReactNode;
  chips: RecordTableRowChip[];
  /** The customization's icon for a chip, when it has one. */
  chipIcon: (chip: RecordTableRowChip) => React.ReactNode | undefined;
};

/**
 * A row's identity (the first column's value) with the row's chips after it. The text keeps the
 * base table's own grammar on both faces — body text clamped at three lines in a desktop cell, the
 * emphasized two-line identity line on a phone card — so a row with no chips reads exactly as it
 * does in a table with no customization. A chip is the house's quiet outlined pill in the
 * secondary ink: a fact beside the name, never a warning.
 */
export function IdentityCellValue({ value, rendered, chips, chipIcon }: IdentityCellValueProps) {
  const { isPhone } = useFormFactor();
  if (value == null || value === '') {
    return <EmptyCellValue />;
  }

  const text = String(value);
  const identity =
    rendered !== undefined ? (
      <>{rendered}</>
    ) : isPhone ? (
      <Typography
        sx={{
          overflowWrap: 'anywhere',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          fontWeight: 600,
        }}
      >
        {text}
      </Typography>
    ) : (
      <ClampedTextCellValue>{text}</ClampedTextCellValue>
    );
  if (chips.length === 0) {
    return identity;
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5, minWidth: 0 }}>
      {identity}
      {chips.map((chip) => {
        const icon = chipIcon(chip);
        return (
          <Box
            key={chip.kind ?? chip.label}
            component='span'
            data-record-table-row-chip={chip.kind ?? chip.label}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.625,
              height: 22,
              px: 1.125,
              borderRadius: 999,
              border: '1px solid',
              borderColor: 'divider',
              fontSize: '0.71875rem',
              fontWeight: 400,
              lineHeight: 1,
              color: 'text.secondary',
              whiteSpace: 'nowrap',
              flex: 'none',
            }}
          >
            {icon !== undefined && (
              <Box
                component='span'
                sx={{ display: 'inline-flex', '& svg': { width: 12, height: 12, display: 'block' } }}
              >
                {icon}
              </Box>
            )}
            {chip.label}
          </Box>
        );
      })}
    </Box>
  );
}
