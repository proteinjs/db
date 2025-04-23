import React from 'react';
import { FormPage, Page, Form, Fields, textField, FormButtons } from '@proteinjs/ui';
import { SxProps, Theme } from '@mui/material';

export const hashGeneratorPage: Page = {
  name: 'Hash Generator',
  path: 'hash-generator',
  pageContainerSxProps: (theme: Theme): SxProps => {
    return {
      height: '100vh',
      backgroundColor: theme.palette.background.default,
    };
  },
  component: () => (
    <FormPage>
      <Form<HashGeneratorFields, typeof buttons>
        name='Hash Generator'
        createFields={() => new HashGeneratorFields()}
        fieldLayout={['input', 'hash']}
        buttons={buttons}
      />
    </FormPage>
  ),
};

class HashGeneratorFields extends Fields {
  input = textField<HashGeneratorFields>({
    name: 'input',
  });
  hash = textField<HashGeneratorFields>({
    name: 'hash',
  });
}

const buttons: FormButtons<HashGeneratorFields> = {
  generate: {
    name: 'Generate',
    style: {
      color: 'primary',
      variant: 'contained',
    },
    onClick: async (fields: HashGeneratorFields, buttons: FormButtons<HashGeneratorFields>) => {
      fields.hash.field.value = await generateSHA256(fields.input.field.value);
    },
  },
};

async function generateSHA256(input: string = '') {
  // Convert the input string to an ArrayBuffer
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  // Generate the hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert the hash to a hexadecimal string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}
