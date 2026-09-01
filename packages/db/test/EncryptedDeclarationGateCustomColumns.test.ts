/**
 * The declaration gate is DEFAULT-SUSPECT (TRUST_AND_COMPLIANCE classification principle:
 * ambiguity resolves to the declared side): a column class the core cannot classify as
 * provably non-text — e.g. a driver-specific JSON column implementing `Column` directly —
 * must declare `encrypted` (false, or move to a string-serialized class to encrypt). Without
 * this inversion, JSON-typed free-text payloads (thought bodies, reasoning traces) would
 * slip past `requireEncryptedDeclarations` unclassified.
 */
import { Column, Table } from '../src/Table';
import { IntegerColumn, StringColumn } from '../src/Columns';
import { Record, withRecordColumns } from '../src/Record';
import { EncryptedColumns } from '../src/encryption/EncryptedColumns';
import { EncryptedColumnConfigError } from '../src/encryption/DbEncryptionConfig';

/** Stand-in for spanner-common's JsonColumn: a custom class OUTSIDE the StringColumn family. */
class FakeJsonColumn<T> implements Column<T, any> {
  constructor(
    public name: string,
    public options?: any
  ) {}
  async serialize(value: T | null | undefined): Promise<any> {
    return value ?? null;
  }
  async deserialize(serialized: any): Promise<T | null> {
    return serialized ?? null;
  }
}

interface GateRow extends Record {
  payload?: any;
  count?: number;
  note?: string | null;
}

const makeTable = (payloadOptions?: any) =>
  new (class extends Table<GateRow> {
    name = 'gate_custom_column_test';
    columns: Table<GateRow>['columns'] = withRecordColumns<GateRow>({
      payload: new FakeJsonColumn('payload', payloadOptions),
      count: new IntegerColumn('count'),
      note: new StringColumn('note', { encrypted: false }),
    });
  })();

describe('requireEncryptedDeclarations covers custom/JSON column classes', () => {
  test('an undeclared custom column class fails the gate, naming the column', () => {
    expect(() => new EncryptedColumns().validateDeclarations(makeTable())).toThrow(EncryptedColumnConfigError);
    expect(() => new EncryptedColumns().validateDeclarations(makeTable())).toThrow(/payload/);
  });

  test('declaring encrypted: false on the custom column satisfies the gate', () => {
    expect(() => new EncryptedColumns().validateDeclarations(makeTable({ encrypted: false }))).not.toThrow();
  });

  test('provably non-text columns (numbers, ids, timestamps) stay exempt', () => {
    const table = makeTable({ encrypted: false });
    // count (IntegerColumn) and the inherited id/created/updated columns need no declaration.
    expect(() => new EncryptedColumns().validateDeclarations(table)).not.toThrow();
  });

  test('a custom column class still cannot declare encrypted (string-serialized classes only)', () => {
    const table = makeTable({ encrypted: {} });
    expect(() => new EncryptedColumns().ensureSchema(table)).toThrow(/StringColumn family/);
  });
});
