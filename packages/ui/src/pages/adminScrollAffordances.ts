import type { Theme } from '@mui/material';
import type { ScrollTopButtonStyleProps } from '@proteinjs/ui';

/**
 * The admin record surfaces' scroll-container affordances (founder ruling, admin round 3):
 * every admin table scroller carries the top-edge fade and the floating back-to-top button.
 * One owner for the wiring so the record table page and the Tables browser can't drift.
 *
 * The button adopts the consumer app's house elevation tokens when its theme augments MUI
 * with `customShadows` (button at rest, widget on hover — the shape util-ui's
 * `scrollTopButtonStyle` documents); themes without the tokens keep the framework default
 * styling untouched. Read through a loose cast — this layer can't import an app theme.
 */
export const adminScrollTopButton: ScrollTopButtonStyleProps = {
  buttonSx: (theme: Theme) => {
    const customShadows = (theme as unknown as { customShadows?: { button?: string; widget?: string } }).customShadows;
    if (!customShadows?.button) {
      return {};
    }

    return {
      boxShadow: customShadows.button,
      '&:hover': {
        backgroundColor: theme.palette.background.paper,
        boxShadow: customShadows.widget ?? customShadows.button,
      },
    };
  },
};

/** Spread into a `Table`/`RecordTable` on an admin surface. */
export const adminScrollAffordances = {
  scrollTopButton: adminScrollTopButton,
  topScrollFade: true,
} as const;
