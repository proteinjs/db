import {
  Db,
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
  Record,
  Reference,
  ReferenceColumn,
  StringColumn,
  Table,
  TransactionRunner,
  getDbAsSystem,
  tableByName,
  withRecordColumns,
} from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * A write declares the rows it depends on (`TransactionRunner.run(ops, { afterRows })`) and the
 * server waits, bounded, for each to exist and be visible to the caller before running the
 * operations (WritesDeclareTheirDependencies). What an INSERT may declare is under test here.
 *
 * Contract: an insert references every row its table's reference columns name — the row a
 * `ReferenceColumn` points at, in the column's declared table; the row a `DynamicReferenceColumn`
 * points at, in the table its paired table-name column carries on the record (else the
 * reference's own). The permission source a row attaches to is one of these, not a case of its
 * own. So a record born in one request whose reference column names a row still being born in
 * another may declare that row, and the server orders the two: the insert runs once the row it
 * names is there. A declared id that no column references is still refused up front — a value
 * that happens to sit in a plain column is not a reference — and a row the transaction itself
 * inserts is never a dependency.
 *
 * The dependency is modelled as it happens: the referenced row's insert is dispatched AFTER the
 * dependent insert arrives, landing N ms later, in a second transaction.
 */

/** The referenced side: a row other rows attach to. */
interface Document extends Record {
  title: string;
}

class ReferencedDocumentTestTable extends Table<Document> {
  name = 'db_test_referenced_document';
  columns = withRecordColumns<Document>({
    title: new StringColumn('title'),
  });
}

/** The referencing side: a row whose reference column names a document. */
interface Attachment extends Record {
  name: string;
  document: Reference<Document>;
}

class ReferencingAttachmentTestTable extends Table<Attachment> {
  name = 'db_test_referencing_attachment';
  columns = withRecordColumns<Attachment>({
    name: new StringColumn('name'),
    document: new ReferenceColumn<Document>('document', 'db_test_referenced_document', false),
  });
}

/** A row that attaches to a permission source through the dynamic reference pair. */
interface ScopedNote extends Record {
  text: string;
  permissionSource?: Reference<Record>;
  permissionSourceTable?: string;
}

class ScopedNoteTestTable extends Table<ScopedNote> {
  name = 'db_test_scoped_note';
  columns = withRecordColumns<ScopedNote>({
    text: new StringColumn('text'),
    permissionSourceTable: new DynamicReferenceTableNameColumn('permission_source_table', 'permission_source'),
    permissionSource: new DynamicReferenceColumn<Record>('permission_source', 'permission_source_table', false),
  });
}

const documentTable: Table<Document> = new ReferencedDocumentTestTable();
const attachmentTable: Table<Attachment> = new ReferencingAttachmentTestTable();
const scopedNoteTable: Table<ScopedNote> = new ScopedNoteTestTable();
const tables: Table<any>[] = [documentTable, attachmentTable, scopedNoteTable];
const getTable = (tableName: string) => tables.find((table) => table.name === tableName) ?? tableByName(tableName);
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
const spannerDriver = new SpannerDriver(spannerConfig, getTable);

/** The request as it arrives at the server: an operations array and the declared rows. */
type Runner = { run: (ops: unknown[], options?: { afterRows?: string[] }) => Promise<void> };
type LoggedLine = { message?: string; obj?: { afterRows?: string[]; polls?: number } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const registry = () => (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache;

/**
 * Run `work` with every line the process logs captured: the runner constructs its logger without
 * a writer, so the line it prints reaches the registered default log writer — the registry's
 * `@proteinjs/logger/DefaultLogWriter` object, resolved at the first write.
 */
const withLoggedLines = async <T>(work: (lines: LoggedLine[]) => Promise<T>): Promise<T> => {
  const lines: LoggedLine[] = [];
  const previous = registry()['@proteinjs/logger/DefaultLogWriter'];
  registry()['@proteinjs/logger/DefaultLogWriter'] = [{ write: (line: LoggedLine) => lines.push(line) }];
  try {
    return await work(lines);
  } finally {
    if (previous) {
      registry()['@proteinjs/logger/DefaultLogWriter'] = previous;
    } else {
      delete registry()['@proteinjs/logger/DefaultLogWriter'];
    }
  }
};

describe('an insert declares the rows its reference columns name; the server waits for them', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());
  let inserts: Promise<unknown>[] = [];

  beforeAll(async () => {
    registerTestUser();
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = tables;
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    for (const table of tables) {
      await spannerDriver.getTableManager().loadTable(table);
    }
  }, 60000);

  afterAll(async () => {
    for (const table of [...tables].reverse()) {
      await dropTable(table);
    }
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  afterEach(async () => {
    await Promise.all(inserts);
    inserts = [];
    for (const table of [...tables].reverse()) {
      const leftovers = await getDbAsSystem().query(table, {});
      for (const row of leftovers) {
        await getDbAsSystem().delete(table, { id: row.id } as any);
      }
    }
  }, 30000);

  /** The referenced row's insert, dispatched `afterMs` after now in its own transaction. */
  const insertLater = (row: Partial<Document>, afterMs: number) => {
    const insert = sleep(afterMs).then(() => getDbAsSystem().insert(documentTable, row as any));
    inserts.push(insert);
    return insert;
  };

  test('afterRows may name the row an insert references through a reference column: the write waits for the row, then lands naming it', async () => {
    const documentId = 'referenced-document-a';
    const attachmentId = 'referencing-attachment-a';
    const document = insertLater({ id: documentId, title: 'the document' }, 300);
    const runner = new TransactionRunner() as unknown as Runner;
    const ops = [
      {
        name: 'insert',
        args: [
          attachmentTable,
          { id: attachmentId, name: 'a scan', document: new Reference(documentTable.name, documentId) },
        ],
      },
    ];

    const before = Date.now();
    const lines = await withLoggedLines(async (lines) => {
      await runner.run(ops, { afterRows: [documentId] });
      return lines;
    });
    const elapsed = Date.now() - before;
    await document;

    // Before the rule: refused up front — "afterRows names rows none of the operations reference
    // (referenced-document-a) — the write was not run" — the insert's reference column was not a
    // dependency the runner could see. With the rule, the write waited for the document and the
    // attachment landed naming a row that is there.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect((await db.get(attachmentTable, { id: attachmentId })).document._id).toBe(documentId);
    expect((await db.get(documentTable, { id: documentId })).title).toBe('the document');
    // The runner's one line when the seam did work: the declared row landed while the write waited.
    const waited = lines.find((line) => line.message === 'Declared rows present');
    expect(waited?.obj).toMatchObject({ afterRows: [documentId] });
    expect(waited?.obj?.polls).toBeGreaterThan(1);
  }, 30000);

  test('a declared id no column references is still refused up front — a value that sits in a plain column is not a reference', async () => {
    const runner = new TransactionRunner() as unknown as Runner;
    const attachmentId = 'referencing-attachment-b';
    const ops = [
      {
        name: 'insert',
        args: [
          attachmentTable,
          {
            id: attachmentId,
            // The declared id is this row's NAME — a string column — not a row it references.
            name: 'referenced-document-b',
            document: new Reference(documentTable.name, 'referenced-document-other'),
          },
        ],
      },
    ];

    await expect(runner.run(ops, { afterRows: ['referenced-document-b'] })).rejects.toThrow(
      /afterRows names rows none of the operations reference \(referenced-document-b\) — the write was not run/
    );
    expect(await getDbAsSystem().get(attachmentTable, { id: attachmentId })).toBeUndefined();
  }, 30000);

  test('a row the transaction itself inserts is not a dependency — a root that attaches to itself included', async () => {
    const runner = new TransactionRunner() as unknown as Runner;
    const rootId = 'scoped-note-root';
    const ops = [
      {
        name: 'insert',
        args: [
          scopedNoteTable,
          {
            id: rootId,
            text: 'a root',
            permissionSource: new Reference(scopedNoteTable.name, rootId),
            permissionSourceTable: scopedNoteTable.name,
          },
        ],
      },
    ];

    await expect(runner.run(ops, { afterRows: [rootId] })).rejects.toThrow(
      /afterRows names rows none of the operations reference \(scoped-note-root\) — the write was not run/
    );
    expect(await getDbAsSystem().get(scopedNoteTable, { id: rootId })).toBeUndefined();
  }, 30000);

  test('the permission source a row attaches to is one case of the rule: the table from the paired table-name column on the record, else from the reference itself', async () => {
    const sourceId = 'referenced-document-c';
    const source = insertLater({ id: sourceId, title: 'the scope' }, 300);
    const runner = new TransactionRunner() as unknown as Runner;
    // Two rows attach to the same source in one request: one carrying the table-name column as
    // a client's queued insert does (column defaults ran there), one carrying only the reference.
    const ops = [
      {
        name: 'insert',
        args: [
          scopedNoteTable,
          {
            id: 'scoped-note-c-named',
            text: 'the table named on the record',
            permissionSource: new Reference(documentTable.name, sourceId),
            permissionSourceTable: documentTable.name,
          },
        ],
      },
      {
        name: 'insert',
        args: [
          scopedNoteTable,
          {
            id: 'scoped-note-c-reference',
            text: 'the table from the reference',
            permissionSource: new Reference(documentTable.name, sourceId),
          },
        ],
      },
    ];

    const before = Date.now();
    await runner.run(ops, { afterRows: [sourceId] });
    const elapsed = Date.now() - before;
    await source;

    expect(elapsed).toBeGreaterThanOrEqual(250);
    for (const id of ['scoped-note-c-named', 'scoped-note-c-reference']) {
      const landed = await db.get(scopedNoteTable, { id });
      expect(landed.permissionSource?._id).toBe(sourceId);
      expect(landed.permissionSourceTable).toBe(documentTable.name);
    }
  }, 30000);
});
