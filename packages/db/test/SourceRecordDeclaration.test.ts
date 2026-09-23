import moment from 'moment';
import { SourceRecordDeclaration, SourceRecordDeclarationDocument } from '../src/source/SourceRecordDeclaration';
import { Table } from '../src/Table';
import { withSourceRecordColumns, SourceRecord } from '../src/source/SourceRecord';
import { DateTimeColumn, IntegerColumn, StringColumn } from '../src/Columns';

/**
 * The declaration document: byte-stable rendering, strict parsing, and the value round trip
 * (dates as ISO strings, everything else JSON-native) between a table's records and the file.
 */
interface Widget extends SourceRecord {
  sku: string;
  name: string;
  price?: number | null;
  releasedAt?: moment.Moment | null;
  apiKey?: string | null;
}

class WidgetTable extends Table<Widget> {
  name = 'widget';
  columns = withSourceRecordColumns<Widget>({
    sku: new StringColumn('sku', { unique: { unique: true, indexName: 'widget_sku' } }),
    name: new StringColumn('name'),
    price: new IntegerColumn('price'),
    releasedAt: new DateTimeColumn('released_at'),
    apiKey: new StringColumn('api_key'),
  });
  sourceRecordOptions: Table<Widget>['sourceRecordOptions'] = {
    naturalKey: 'sku',
    declarationColumns: ['name', 'price', 'releasedAt'],
  };
}

const table = new WidgetTable();
const header = { environment: 'fixture', exportedAt: '2026-01-01T00:00:00.000Z' };

const declaration = (): SourceRecordDeclaration => ({
  format: 'source-records/1',
  table: 'widget',
  key: 'sku',
  columns: ['sku', 'name', 'price', 'releasedAt'],
  environment: 'fixture',
  exportedAt: header.exportedAt,
  rowCount: 2,
  rows: [
    { sku: 'B', name: 'Bee', price: 2, releasedAt: null },
    { name: 'Ay', sku: 'A', releasedAt: '2026-02-03T04:05:06.000Z', price: 1 },
  ],
});

describe('SourceRecordDeclarationDocument.render', () => {
  it('is byte-stable: keys sorted at every level, rows sorted by the key, two-space indent, a trailing newline', () => {
    const text = SourceRecordDeclarationDocument.render(declaration());
    expect(text).toBe(
      [
        '{',
        '  "columns": [',
        '    "name",',
        '    "price",',
        '    "releasedAt",',
        '    "sku"',
        '  ],',
        '  "environment": "fixture",',
        '  "exportedAt": "2026-01-01T00:00:00.000Z",',
        '  "format": "source-records/1",',
        '  "key": "sku",',
        '  "rowCount": 2,',
        '  "rows": [',
        '    {',
        '      "name": "Ay",',
        '      "price": 1,',
        '      "releasedAt": "2026-02-03T04:05:06.000Z",',
        '      "sku": "A"',
        '    },',
        '    {',
        '      "name": "Bee",',
        '      "price": 2,',
        '      "releasedAt": null,',
        '      "sku": "B"',
        '    }',
        '  ],',
        '  "table": "widget"',
        '}',
        '',
      ].join('\n')
    );
    // The same rows in another order and with another key order render the same bytes.
    const shuffled = declaration();
    shuffled.rows.reverse();
    shuffled.columns.reverse();
    expect(SourceRecordDeclarationDocument.render(shuffled)).toBe(text);
    expect(SourceRecordDeclarationDocument.render(SourceRecordDeclarationDocument.parse(text))).toBe(text);
  });
});

describe('SourceRecordDeclarationDocument.parse', () => {
  const text = SourceRecordDeclarationDocument.render(declaration());

  it('reads a rendered document back, columns sorted', () => {
    expect(SourceRecordDeclarationDocument.parse(text)).toMatchObject({
      table: 'widget',
      key: 'sku',
      columns: ['name', 'price', 'releasedAt', 'sku'],
      environment: 'fixture',
      rowCount: 2,
    });
  });

  it('refuses by name: not JSON, another format, a missing field, a row outside the columns, a row without its key, a wrong count', () => {
    expect(() => SourceRecordDeclarationDocument.parse('{', 'f.json')).toThrow(/f\.json is not JSON/);
    expect(() => SourceRecordDeclarationDocument.parse(text.replace('source-records/1', 'other/9'))).toThrow(
      /has format 'other\/9'/
    );
    expect(() => SourceRecordDeclarationDocument.parse(text.replace('"environment": "fixture",', ''))).toThrow(
      /missing 'environment'/
    );
    expect(() =>
      SourceRecordDeclarationDocument.parse(text.replace('"name": "Ay",', '"name": "Ay",\n      "apiKey": "x",'))
    ).toThrow(/row 0 carries 'apiKey'/);
    expect(() => SourceRecordDeclarationDocument.parse(text.replace('"sku": "A"', '"sku": null'))).toThrow(
      /row 0 has no 'sku'/
    );
    expect(() => SourceRecordDeclarationDocument.parse(text.replace('"rowCount": 2', '"rowCount": 5'))).toThrow(
      /rowCount 5 but 2 rows/
    );
    expect(() => SourceRecordDeclarationDocument.parse(text.replace('"key": "sku"', '"key": "id"'))).toThrow(
      /the key 'id' is not among its columns/
    );
  });
});

describe('SourceRecordDeclarationDocument — records ⇄ rows', () => {
  it('fromRecords renders the declaration columns plus the key and nothing else, dates as ISO strings, sorted by key', async () => {
    const built = await SourceRecordDeclarationDocument.fromRecords(
      table,
      [
        { id: 'x', sku: 'B', name: 'Bee', price: 2, apiKey: 'sk-secret', releasedAt: null },
        {
          id: 'y',
          sku: 'A',
          name: 'Ay',
          price: 1,
          apiKey: 'sk-secret',
          releasedAt: moment.utc('2026-02-03T04:05:06Z'),
        },
      ],
      header
    );
    expect(built).toEqual(SourceRecordDeclarationDocument.parse(SourceRecordDeclarationDocument.render(declaration())));
    expect(JSON.stringify(built)).not.toContain('sk-secret');
    expect(JSON.stringify(built)).not.toContain('"id"');
  });

  it('toRecords gives the table its values back: ISO strings become moments on date-time columns', async () => {
    const records = await SourceRecordDeclarationDocument.toRecords(table, declaration());
    expect(records.map((record) => record.sku)).toEqual(['B', 'A']);
    const a = records[1];
    expect(moment.isMoment(a.releasedAt)).toBe(true);
    expect((a.releasedAt as moment.Moment).toISOString()).toBe('2026-02-03T04:05:06.000Z');
    expect(records[0].releasedAt).toBeNull();
    // The round trip is exact.
    const again = await SourceRecordDeclarationDocument.fromRecords(table, records, header);
    expect(SourceRecordDeclarationDocument.sameRows(again, declaration())).toBe(true);
  });

  it('toRecords refuses another table, another key, a column the table does not declare, and a date that is not ISO', async () => {
    await expect(
      SourceRecordDeclarationDocument.toRecords(table, { ...declaration(), table: 'other' })
    ).rejects.toThrow(/is for table 'other'/);
    await expect(
      SourceRecordDeclarationDocument.toRecords(table, { ...declaration(), key: 'id', columns: ['id', 'name'] })
    ).rejects.toThrow(/keys on 'id'; the table syncs on 'sku'/);
    await expect(
      SourceRecordDeclarationDocument.toRecords(table, {
        ...declaration(),
        columns: [...declaration().columns, 'apiKey'],
      })
    ).rejects.toThrow(/'apiKey', which is not a declaration column/);
    const badDate = declaration();
    badDate.rows[1].releasedAt = 'yesterday';
    await expect(SourceRecordDeclarationDocument.toRecords(table, badDate)).rejects.toThrow(/must be an ISO-8601/);
  });

  it('fromRecords refuses a value the format cannot carry', async () => {
    class Weird {
      x = 1;
    }
    await expect(
      SourceRecordDeclarationDocument.fromRecords(table, [{ sku: 'A', name: 'Ay', price: new Weird() as any }], header)
    ).rejects.toThrow(/'price' holds a value the declaration format cannot carry/);
  });

  it('sameRows compares the body, never the header time', () => {
    const a = declaration();
    const b = { ...declaration(), exportedAt: '2027-01-01T00:00:00.000Z' };
    expect(SourceRecordDeclarationDocument.sameRows(a, b)).toBe(true);
    const c = declaration();
    c.rows[0].price = 99;
    expect(SourceRecordDeclarationDocument.sameRows(a, c)).toBe(false);
    expect(SourceRecordDeclarationDocument.sameRows(a, { ...declaration(), environment: 'elsewhere' })).toBe(false);
  });
});
