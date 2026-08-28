import { Table } from '../src/Table';
import { EncryptionDerivedTableRegistry } from '../src/encryption/EncryptionDerivedTableRegistry';
import { withRecordColumns, Record } from '../src/Record';
import { ObjectColumn, ReferenceColumn, StringColumn, UuidColumn } from '../src/Columns';
import { EncryptedColumns } from '../src/encryption/EncryptedColumns';
import { EncryptedColumnConfigError } from '../src/encryption/DbEncryptionConfig';

interface Note extends Record {
  title?: string;
  body?: string;
  label?: string;
  attachments?: string;
  plain?: string;
}

const noteTable = (columns: any): Table<Note> =>
  new (class extends Table<Note> {
    name = `enc_schema_test_${schemaTestTableCounter++}`;
    columns = columns;
  })();

let schemaTestTableCounter = 0;

/**
 * The schema side of `ColumnOptions.encrypted`: declaration validation (invalid states
 * rejected loudly), derived companion columns / token table, ciphertext widening, and the
 * mandatory-declaration gate.
 */
describe('EncryptedColumns schema derivation', () => {
  const encryptedColumns = new EncryptedColumns();

  test('derives companions automatically: MAX widening, equality fingerprint column + index, sort prefix column, token table', () => {
    const table = noteTable(
      withRecordColumns<any>({
        title: new StringColumn('title', { encrypted: { searchable: 'contains' } }),
        label: new StringColumn('label', { encrypted: { searchable: 'equality', sortKey: { revealPrefix: 3 } } }),
        body: new ObjectColumn('body', { encrypted: {} }),
        plain: new StringColumn('plain', { encrypted: false }),
      })
    );
    encryptedColumns.ensureSchema(table);

    // ciphertext outgrows declared widths
    expect((table.columns.title as StringColumn).maxLength).toBe('MAX');
    expect((table.columns.label as StringColumn).maxLength).toBe('MAX');
    // plaintext column untouched
    expect((table.columns.plain as StringColumn).maxLength).toBe(255);

    // equality fingerprint companion, indexed
    const eqCompanion = (table.columns as any)[encryptedColumns.eqCompanionProp(table, 'label')];
    expect(eqCompanion).toBeTruthy();
    expect(eqCompanion.name).toBe('label_enc_eq');
    expect(table.indexes.some((index) => index.name === `${table.name}_label_enc_eq_idx`)).toBe(true);

    // sort prefix companion bounded to the declared reveal
    const sortCompanion = (table.columns as any)[encryptedColumns.sortCompanionProp(table, 'label')];
    expect(sortCompanion.name).toBe('label_enc_srt');
    expect(sortCompanion.maxLength).toBe(3);

    // token table registered in the derived registry (tableByName's fallback — the
    // full tableByName resolution is covered by the driver integration tests, which run
    // with a real reflection graph)
    const tokenTable = encryptedColumns.tokenTableFor(table)!;
    expect(tokenTable.name).toBe(`${table.name}_enc_tok`);
    expect(EncryptionDerivedTableRegistry.get(tokenTable.name)).toBe(tokenTable);

    // idempotent: a second pass adds nothing
    const columnCount = Object.keys(table.columns).length;
    const indexCount = table.indexes.length;
    encryptedColumns.ensureSchema(table);
    expect(Object.keys(table.columns).length).toBe(columnCount);
    expect(table.indexes.length).toBe(indexCount);
  });

  test('a unique declaration moves onto the equality fingerprint (per-owner value uniqueness)', () => {
    const table = noteTable(
      withRecordColumns<any>({
        label: new StringColumn('label', {
          unique: { unique: true },
          encrypted: { searchable: 'equality' },
        }),
      })
    );
    encryptedColumns.ensureSchema(table);
    expect((table.columns.label as StringColumn).options?.unique).toBeUndefined();
    const eqCompanion = (table.columns as any)[encryptedColumns.eqCompanionProp(table, 'label')];
    expect(eqCompanion.options.unique.unique).toBe(true);
  });

  test('rejects: unique without equality declaration (a unique index on ciphertext cannot bite)', () => {
    const table = noteTable(
      withRecordColumns<any>({
        label: new StringColumn('label', { unique: { unique: true }, encrypted: {} }),
      })
    );
    expect(() => encryptedColumns.ensureSchema(table)).toThrow(EncryptedColumnConfigError);
    expect(() => encryptedColumns.ensureSchema(table)).toThrow(/searchable: 'equality'/);
  });

  test('rejects: encrypted on reference/id columns (metadata by construction)', () => {
    const table = noteTable(
      withRecordColumns<any>({
        attachments: new ReferenceColumn('attachment', 'other_table', false, { encrypted: {} } as any),
      })
    );
    expect(() => encryptedColumns.ensureSchema(table)).toThrow(EncryptedColumnConfigError);
  });

  test('rejects: searchable/sortKey on serialized-object columns (derivatives cover text, not serialization)', () => {
    const table = noteTable(
      withRecordColumns<any>({
        body: new ObjectColumn('body', { encrypted: { searchable: 'contains' } }),
      })
    );
    expect(() => encryptedColumns.ensureSchema(table)).toThrow(EncryptedColumnConfigError);
  });

  test('rejects: malformed nested config values', () => {
    const badSearchable = noteTable(
      withRecordColumns<any>({
        title: new StringColumn('title', { encrypted: { searchable: 'fuzzy' } as any }),
      })
    );
    expect(() => encryptedColumns.ensureSchema(badSearchable)).toThrow(EncryptedColumnConfigError);

    const badReveal = noteTable(
      withRecordColumns<any>({
        title: new StringColumn('title', { encrypted: { sortKey: { revealPrefix: 0 } } }),
      })
    );
    expect(() => encryptedColumns.ensureSchema(badReveal)).toThrow(EncryptedColumnConfigError);
  });

  test('a rejected declaration stays rejected on every use (no half-applied schema)', () => {
    const table = noteTable(
      withRecordColumns<any>({
        title: new StringColumn('title', { encrypted: { searchable: 'fuzzy' } as any }),
      })
    );
    expect(() => encryptedColumns.ensureSchema(table)).toThrow(EncryptedColumnConfigError);
    expect(() => encryptedColumns.ensureSchema(table)).toThrow(EncryptedColumnConfigError);
  });
});

describe('EncryptedColumns mandatory declarations (the sweep-wave gate)', () => {
  const encryptedColumns = new EncryptedColumns();

  test('a text column without an encrypted declaration fails validation, naming the column', () => {
    const table = noteTable(
      withRecordColumns<any>({
        title: new StringColumn('title'),
        plain: new StringColumn('plain', { encrypted: false }),
      })
    );
    encryptedColumns.ensureSchema(table);
    expect(() => encryptedColumns.validateDeclarations(table)).toThrow(EncryptedColumnConfigError);
    expect(() => encryptedColumns.validateDeclarations(table)).toThrow(/title/);
  });

  test('declared columns (false or config), id/reference columns, and derived companions pass', () => {
    const table = noteTable(
      withRecordColumns<any>({
        title: new StringColumn('title', { encrypted: { searchable: 'equality' } }),
        plain: new StringColumn('plain', { encrypted: false }),
        attachments: new ReferenceColumn('attachment', 'other_table', false),
        label: new UuidColumn('label'),
      })
    );
    encryptedColumns.ensureSchema(table);
    expect(() => encryptedColumns.validateDeclarations(table)).not.toThrow();
  });
});
