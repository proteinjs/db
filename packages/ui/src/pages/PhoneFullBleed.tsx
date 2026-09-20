import React from 'react';
import { Box } from '@mui/material';

export type PhoneFullBleedProps = {
  /**
   * What the page hands the pane:
   *  - `form` — content that reads down the page (a form, a form with its panels). The box IS the
   *    page's scroller and carries the pane's one 16px reading edge; the form adds none of its own.
   *  - `table` — a table, which owns its scroller and its reading edge. The box is a flex column
   *    that hands it the rest of the viewport and adds no inset.
   */
  content: 'form' | 'table';
  children?: React.ReactNode;
};

/**
 * A page's phone face: FULL-BLEED under the shell's chrome — no card, no page gutters, no page
 * top margin. Every page in this package that forks on the phone renders through this one box, so
 * the pane has one reading edge and one way of filling the shell's flex page column (flex-grow 1 +
 * min-height 0: the rest of the viewport, scrolled inside). Desktop faces stay with their pages.
 */
export function PhoneFullBleed({ content, children }: PhoneFullBleedProps) {
  if (content === 'table') {
    return (
      <Box
        data-phone-fullbleed
        sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, width: '100%' }}
      >
        {children}
      </Box>
    );
  }

  return (
    <Box data-phone-fullbleed sx={{ flexGrow: 1, minHeight: 0, width: '100%', overflow: 'auto', padding: 2 }}>
      {children}
    </Box>
  );
}
