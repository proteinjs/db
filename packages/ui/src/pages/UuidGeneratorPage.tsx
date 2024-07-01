import React from 'react';
import { FormPage, Page, Form, Fields, textField, FormButtons } from '@proteinjs/ui';
import { v1 as uuidv1 } from 'uuid';
import { SxProps, Theme } from '@mui/material';

export const uuidGeneratorPage: Page = {
  name: 'Uuid Generator',
  path: 'uuid-generator',
  pageContainerSxProps: (theme: Theme): SxProps => {
    return {
      height: '100vh',
      backgroundColor: theme.palette.background.default,
    };
  },
  component: () => (
    <FormPage>
      <Form<UuidFields, typeof buttons>
        name='Uuid Generator'
        createFields={() => new UuidFields()}
        fieldLayout={['uuid']}
        buttons={buttons}
      />
    </FormPage>
  ),
};

class UuidFields extends Fields {
  uuid = textField<UuidFields>({
    name: 'uuid',
  });
}

const buttons: FormButtons<UuidFields> = {
  generate: {
    name: 'Generate',
    style: {
      color: 'primary',
      variant: 'contained',
    },
    onClick: async (fields: UuidFields, buttons: FormButtons<UuidFields>) => {
      fields.uuid.field.value = uuidv1();
    },
  },
};
