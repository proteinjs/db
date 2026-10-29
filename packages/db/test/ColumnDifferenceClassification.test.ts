import { Logger } from '@proteinjs/logger';
import { TableManager } from '../src/schema/TableManager';
import { Table } from '../src/Table';
import { IntegerColumn, StringColumn } from '../src/Columns';
import { Record, withRecordColumns } from '../src/Record';

/**
 * The reconcile's classification of a declared column against its live column, without a driver:
 * which differences become changes a driver must make or refuse, and which the sync leaves as
 * they stand because the schema only moves forward.
 *
 * Judged by outcomes: what the driver is asked to alter (and with what), what the typed delta
 * says, and the lines the sync writes — one per column per sync, names and types only.
 */

interface Note extends Record {
  note: string;
  qty: number;
}

class NoteTable extends Table<Note> {
  public name = 'forward_note';
  public columns = withRecordColumns<Note>({
    note: new StringColumn('note'),
    qty: new IntegerColumn('qty'),
  });
}

type CapturedLog = { logLevel: string; message?: string; obj?: any };
type Live = { [columnName: string]: { type: string; isNullable: boolean } };
type ColumnTypeChange = { name: string; newType: string; oldType: string; nullable: boolean };
type ToleratedColumnDifference =
  | { name: string; difference: 'wider-type'; declaredType: string; physicalType: string }
  | { name: string; difference: 'nullable' }
  | { name: string; difference: 'not-null' };
type Delta = {
  columnsToAlter: string[];
  columnTypeChanges: ColumnTypeChange[];
  toleratedColumnDifferences: ToleratedColumnDifference[];
};
type ManagerInternals = {
  logger: Logger;
  alterTableIfChanged(table: Table<any>): Promise<void>;
  getTableChanges(table: Table<any>): Promise<Delta>;
  getIndexOperations(table: Table<any>): Promise<{ indexesToCreate: unknown[]; indexesToDrop: unknown[] }>;
};

/** The stock live shape of NoteTable: every column as declared. */
const liveAsDeclared = (): Live => ({
  id: { type: 'STRING(36)', isNullable: false },
  created: { type: 'TIMESTAMP', isNullable: true },
  updated: { type: 'TIMESTAMP', isNullable: true },
  note: { type: 'STRING(MAX)', isNullable: true },
  qty: { type: 'INT64', isNullable: true },
});

describe('the classification of a declared column against its live column', () => {
  let captured: CapturedLog[];
  let altered: Delta[];

  /** A manager over `live`, declaring `declared` types (defaults: the stock types of NoteTable). */
  const managerWhere = (live: Live, declared: { [columnName: string]: string } = {}) => {
    const stockTypes: { [columnName: string]: string } = {
      id: 'STRING(36)',
      created: 'TIMESTAMP',
      updated: 'TIMESTAMP',
      note: 'STRING(MAX)',
      qty: 'INT64',
    };
    const manager = new TableManager(
      {} as never,
      { getType: (column: { name: string }) => declared[column.name] ?? stockTypes[column.name] } as never,
      { alterTable: async (_table: Table<any>, changes: Delta) => altered.push(changes) } as never,
      {
        tableExists: async () => true,
        getColumnMetadata: async () => live,
        getUniqueColumns: async () => [],
        getForeignKeys: async () => ({}),
      } as never
    );
    const internals = manager as unknown as ManagerInternals;
    internals.logger = new Logger({
      name: 'TableManager',
      logLevel: 'info',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as never,
    });
    internals.getIndexOperations = async () => ({ indexesToCreate: [], indexesToDrop: [] });
    return internals;
  };

  const lines = (level: 'info' | 'warn') =>
    captured.filter((log) => log.logLevel === level && /left as it stands/.test(log.message ?? ''));

  beforeEach(() => {
    captured = [];
    altered = [];
  });

  describe('left as it stands — no change reaches the driver', () => {
    test('a live STRING(MAX) where STRING(500) is declared', async () => {
      const table = new NoteTable();
      const manager = managerWhere(liveAsDeclared(), { note: 'STRING(500)' });

      await manager.alterTableIfChanged(table);

      expect(altered).toEqual([]);
      const delta = await manager.getTableChanges(table);
      expect(delta.columnTypeChanges).toEqual([]);
      expect(delta.columnsToAlter).toEqual([]);
      expect(delta.toleratedColumnDifferences).toEqual([
        { name: 'note', difference: 'wider-type', declaredType: 'STRING(500)', physicalType: 'STRING(MAX)' },
      ]);
    });

    test('a live STRING(800) where STRING(500) is declared', async () => {
      const live = liveAsDeclared();
      live.note = { type: 'STRING(800)', isNullable: true };
      const manager = managerWhere(live, { note: 'STRING(500)' });

      await manager.alterTableIfChanged(new NoteTable());

      expect(altered).toEqual([]);
      expect((await manager.getTableChanges(new NoteTable())).toleratedColumnDifferences).toEqual([
        { name: 'note', difference: 'wider-type', declaredType: 'STRING(500)', physicalType: 'STRING(800)' },
      ]);
    });

    test('a live NULLABLE column where NOT NULL is declared', async () => {
      const table = new NoteTable();
      table.columns.note = new StringColumn('note', { nullable: false });
      const manager = managerWhere(liveAsDeclared());

      await manager.alterTableIfChanged(table);

      expect(altered).toEqual([]);
      expect((await manager.getTableChanges(table)).toleratedColumnDifferences).toEqual([
        { name: 'note', difference: 'nullable' },
      ]);
    });

    test('a live NOT NULL column where NULLABLE is declared', async () => {
      const table = new NoteTable();
      table.columns.note = new StringColumn('note', { nullable: true });
      const live = liveAsDeclared();
      live.note = { type: 'STRING(MAX)', isNullable: false };
      const manager = managerWhere(live);

      await manager.alterTableIfChanged(table);

      expect(altered).toEqual([]);
      expect((await manager.getTableChanges(table)).toleratedColumnDifferences).toEqual([
        { name: 'note', difference: 'not-null' },
      ]);
    });
  });

  describe('a change the driver must make or refuse', () => {
    test('a live STRING(200) where STRING(500) is declared is a type change carrying the live nullability', async () => {
      const live = liveAsDeclared();
      live.note = { type: 'STRING(200)', isNullable: true };
      const manager = managerWhere(live, { note: 'STRING(500)' });

      await manager.alterTableIfChanged(new NoteTable());

      expect(altered).toHaveLength(1);
      expect(altered[0].columnTypeChanges).toEqual([
        { name: 'note', oldType: 'STRING(200)', newType: 'STRING(500)', nullable: true },
      ]);
      expect(altered[0].columnsToAlter).toEqual(['note']);
      expect(altered[0].toleratedColumnDifferences).toEqual([]);
    });

    test('a live STRING(500) where STRING(MAX) is declared is a type change', async () => {
      const live = liveAsDeclared();
      live.note = { type: 'STRING(500)', isNullable: true };
      const manager = managerWhere(live);

      await manager.alterTableIfChanged(new NoteTable());

      expect(altered).toHaveLength(1);
      expect(altered[0].columnTypeChanges).toEqual([
        { name: 'note', oldType: 'STRING(500)', newType: 'STRING(MAX)', nullable: true },
      ]);
    });

    test('a different base type is a type change: INT64 declared over a live STRING(MAX)', async () => {
      const manager = managerWhere(liveAsDeclared(), { note: 'INT64' });

      await manager.alterTableIfChanged(new NoteTable());

      expect(altered).toHaveLength(1);
      expect(altered[0].columnTypeChanges).toEqual([
        { name: 'note', oldType: 'STRING(MAX)', newType: 'INT64', nullable: true },
      ]);
      expect(altered[0].toleratedColumnDifferences).toEqual([]);
    });

    test('a different family of the same width grammar is a type change: BYTES(MAX) declared over a live STRING(MAX)', async () => {
      const manager = managerWhere(liveAsDeclared(), { note: 'BYTES(MAX)' });

      await manager.alterTableIfChanged(new NoteTable());

      expect(altered).toHaveLength(1);
      expect(altered[0].columnTypeChanges).toEqual([
        { name: 'note', oldType: 'STRING(MAX)', newType: 'BYTES(MAX)', nullable: true },
      ]);
    });

    test('unequal type words that carry no width are a type change: varchar declared over a live longtext', async () => {
      const live = liveAsDeclared();
      live.note = { type: 'longtext', isNullable: true };
      const manager = managerWhere(live, { note: 'varchar' });

      await manager.alterTableIfChanged(new NoteTable());

      expect(altered).toHaveLength(1);
      expect(altered[0].columnTypeChanges).toEqual([
        { name: 'note', oldType: 'longtext', newType: 'varchar', nullable: true },
      ]);
    });

    test('a narrower live column whose nullability also differs: the type change rides, the nullability stands', async () => {
      const table = new NoteTable();
      table.columns.note = new StringColumn('note', { nullable: false }, 500);
      const live = liveAsDeclared();
      live.note = { type: 'STRING(200)', isNullable: true };
      const manager = managerWhere(live, { note: 'STRING(500)' });

      await manager.alterTableIfChanged(table);

      expect(altered).toHaveLength(1);
      expect(altered[0].columnTypeChanges).toEqual([
        { name: 'note', oldType: 'STRING(200)', newType: 'STRING(500)', nullable: true },
      ]);
      expect(altered[0].toleratedColumnDifferences).toEqual([{ name: 'note', difference: 'nullable' }]);
    });
  });

  describe('the lines', () => {
    test('a column left as it stands is named once per sync, at info, with both types — names only', async () => {
      const manager = managerWhere(liveAsDeclared(), { note: 'STRING(500)' });

      await manager.alterTableIfChanged(new NoteTable());

      expect(lines('info')).toHaveLength(1);
      expect(lines('info')[0].message).toContain('[forward_note.note]');
      expect(lines('info')[0].message).toContain('STRING(MAX)');
      expect(lines('info')[0].message).toContain('STRING(500)');
      expect(lines('info')[0].obj).toEqual({
        table: 'forward_note',
        column: 'note',
        declaredType: 'STRING(500)',
        physicalType: 'STRING(MAX)',
      });
      expect(lines('warn')).toHaveLength(0);
    });

    test('a live NOT NULL where NULLABLE is declared is named at warn; a live NULLABLE where NOT NULL is declared at info', async () => {
      const table = new NoteTable();
      table.columns.note = new StringColumn('note', { nullable: true });
      table.columns.qty = new IntegerColumn('qty', { nullable: false });
      const live = liveAsDeclared();
      live.note = { type: 'STRING(MAX)', isNullable: false };
      const manager = managerWhere(live);

      await manager.alterTableIfChanged(table);

      expect(altered).toEqual([]);
      expect(lines('warn')).toHaveLength(1);
      expect(lines('warn')[0].message).toContain(
        '[forward_note.note] Live column is NOT NULL where NULLABLE is declared'
      );
      expect(lines('warn')[0].obj).toEqual({ table: 'forward_note', column: 'note' });
      expect(lines('info')).toHaveLength(1);
      expect(lines('info')[0].message).toContain(
        '[forward_note.qty] Live column is NULLABLE where NOT NULL is declared'
      );
    });

    test('a table whose every column is as declared writes no such line and asks for no alter', async () => {
      const manager = managerWhere(liveAsDeclared());

      await manager.alterTableIfChanged(new NoteTable());

      expect(altered).toEqual([]);
      expect(lines('info')).toHaveLength(0);
      expect(lines('warn')).toHaveLength(0);
    });

    test('two syncs write the line twice — once per sync, never more within one', async () => {
      const manager = managerWhere(liveAsDeclared(), { note: 'STRING(500)' });

      await manager.alterTableIfChanged(new NoteTable());
      await manager.alterTableIfChanged(new NoteTable());

      expect(lines('info')).toHaveLength(2);
    });
  });
});
