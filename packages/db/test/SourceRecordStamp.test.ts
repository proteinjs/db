import { SourceRecordStamp } from '../src/source/SourceRecordStamp';
import { Table } from '../src/Table';
import { withSourceRecordColumns, SourceRecord } from '../src/source/SourceRecord';
import { IntegerColumn, StringColumn } from '../src/Columns';

/**
 * The declaration stamp — the loader's own mark on a row it wrote, and the judge of a row's
 * authorship afterwards: still matching = the declaration's; moved = the product's.
 */
interface Widget extends SourceRecord {
  sku: string;
  name: string;
  price?: number | null;
  stockNote?: string | null;
}

class WidgetTable extends Table<Widget> {
  name = 'widget';
  columns = withSourceRecordColumns<Widget>({
    sku: new StringColumn('sku'),
    name: new StringColumn('name'),
    price: new IntegerColumn('price'),
    stockNote: new StringColumn('stock_note'),
  });
}

describe('SourceRecordStamp', () => {
  const written = { sku: 'A', name: 'Ay', price: 10, stock_note: 'x' };

  it('renders the same stamp for the same values whatever the column order', () => {
    expect(SourceRecordStamp.render(written, ['sku', 'name', 'price'])).toBe(
      SourceRecordStamp.render({ price: 10, name: 'Ay', sku: 'A' }, ['price', 'sku', 'name'])
    );
  });

  it('matches a row whose stamped columns are as written, and a row whose OTHER columns moved', () => {
    const stamp = SourceRecordStamp.render(written, ['sku', 'name', 'price']);
    expect(SourceRecordStamp.matches(stamp, written)).toBe(true);
    expect(SourceRecordStamp.matches(stamp, { ...written, stock_note: 'runtime edit' })).toBe(true);
  });

  it('does not match a row whose stamped column moved — the product edited it', () => {
    const stamp = SourceRecordStamp.render(written, ['sku', 'name', 'price']);
    expect(SourceRecordStamp.matches(stamp, { ...written, name: 'Mine' })).toBe(false);
    expect(SourceRecordStamp.matches(stamp, { ...written, price: 11 })).toBe(false);
  });

  it('normalizes what backing stores reshape: null and absent alike, dates by their instant, object keys sorted', () => {
    const stampNull = SourceRecordStamp.render({ sku: 'A', price: null }, ['sku', 'price']);
    expect(SourceRecordStamp.matches(stampNull, { sku: 'A' })).toBe(true);
    const date = new Date('2026-02-03T04:05:06.000Z');
    const stampDate = SourceRecordStamp.render({ sku: 'A', at: date }, ['sku', 'at']);
    expect(SourceRecordStamp.matches(stampDate, { sku: 'A', at: new Date(date.valueOf()) })).toBe(true);
    const stampObject = SourceRecordStamp.render({ sku: 'A', blob: { b: 1, a: [1, 2] } }, ['sku', 'blob']);
    expect(SourceRecordStamp.matches(stampObject, { sku: 'A', blob: { a: [1, 2], b: 1 } })).toBe(true);
    expect(SourceRecordStamp.matches(stampObject, { sku: 'A', blob: { a: [2, 1], b: 1 } })).toBe(false);
  });

  it('never matches an unreadable stamp — the conservative side is the product’s', () => {
    expect(SourceRecordStamp.matches('not json', written)).toBe(false);
    expect(SourceRecordStamp.matches('{"c":"sku","h":"x"}', written)).toBe(false);
    expect(SourceRecordStamp.columnsOf('nope')).toBeUndefined();
  });

  it('names the declared columns of a record: the table’s columns it carries, minus bookkeeping and the loader’s own stamps', () => {
    const table = new WidgetTable();
    const declared = {
      id: 'w-1',
      sku: 'A',
      name: 'Ay',
      price: 1,
      isLoadedFromSource: true,
      sourcePackage: '@acme/x',
      sourcePackageVersion: '1.0.0',
      declarationStamp: '{}',
      run: () => undefined,
      notAColumn: 'x',
    };
    expect(SourceRecordStamp.declaredColumnNames(table, declared).sort()).toEqual(['name', 'price', 'sku']);
    expect(SourceRecordStamp.columnsOf(SourceRecordStamp.render(written, ['sku', 'name']))).toEqual(['name', 'sku']);
  });
});
