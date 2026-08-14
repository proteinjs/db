import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { recordFormPage } from '../src/pages/RecordFormPage';
import { recordTablePage } from '../src/pages/RecordTablePage';

describe('record form page error states', () => {
  it('renders the not-accessible message for an unknown table (regression: a shadowed catch binding swallowed the message and the page rendered blank)', () => {
    const Form = recordFormPage.component;
    const html = renderToStaticMarkup(<Form urlParams={{ table: 'NotARealTable' }} />);
    expect(html).toContain('Table not accessible in UI: NotARealTable');
  });

  it('renders the missing-param message when no table is provided', () => {
    const Form = recordFormPage.component;
    const html = renderToStaticMarkup(<Form urlParams={{}} />);
    // (apostrophes render HTML-escaped in static markup, so assert around them)
    expect(html).toContain('Table name not provided via the');
  });
});

describe('record table page error states', () => {
  it('renders the not-accessible message outside the table card (the stretched Paper clipped it)', () => {
    const Table = recordTablePage.component;
    const html = renderToStaticMarkup(<Table urlParams={{ name: 'NotARealTable' }} />);
    expect(html).toContain('Table not accessible in UI: NotARealTable');
    expect(html).not.toContain('MuiPaper');
  });

  it('renders the missing-param message when no name is provided', () => {
    const Table = recordTablePage.component;
    const html = renderToStaticMarkup(<Table urlParams={{}} />);
    // (apostrophes render HTML-escaped in static markup, so assert around them)
    expect(html).toContain('Table not provided via the');
  });
});
