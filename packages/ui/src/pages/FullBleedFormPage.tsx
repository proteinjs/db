import React from 'react';
import { FormPage, useFormFactor } from '@proteinjs/ui';
import { PhoneFullBleed } from './PhoneFullBleed';

/**
 * The shell of a page that hosts one form, by form factor: the house `FormPage` card on desktop;
 * on the phone the form takes the FULL mobile view (`PhoneFullBleed`) — inside the card inside
 * FormPage's guttered column the same form read at 32px beside every other page's 16.
 */
export function FullBleedFormPage({ children }: { children?: React.ReactNode }) {
  const { isPhone } = useFormFactor();
  if (isPhone) {
    return <PhoneFullBleed content='form'>{children}</PhoneFullBleed>;
  }

  return <FormPage>{children}</FormPage>;
}
