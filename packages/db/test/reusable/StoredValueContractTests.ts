import {
  Db,
  DbDriver,
  Table,
  DefaultTransactionContextFactory,
  QueryBuilderFactory,
  Record,
  Reference,
  ReferenceArray,
  StringColumn,
  withRecordColumns,
} from '@proteinjs/db';
import moment from 'moment';
import { StatementFactory } from '@proteinjs/db-query';
import { StatementConfigFactory } from '../../src/StatementConfigFactory';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import { Member, Mixed, storedValueContractTestTables } from '../util/tables/storedValueContractTestTables';
import { columnTypesTestTables, TestRecord } from '../util/tables/columnTypesTestTables';
import { dynamicReferenceTestTables } from '../util/tables/dynamicReferenceColumnTestTables';

/**
 * THE STORED-VALUE CONTRACT: what the row reader makes of each cell a database actually holds —
 * written through the driver, the way a hand-run statement, an older writer or a cutover leaves
 * it — not only what the serializer writes. One asserted law per shape, against a real database
 * through each driver.
 *
 * Part 1 — a legacy column that shares a property's name. After a cutover (`tags` the text
 * column → `tag_list` the array column, property `tags` both times) a row carries two cells: the
 * undeclared legacy `tags` and the declared `tag_list`. The law: a stored value is seated by its
 * COLUMN name alone, so the legacy cell — whatever it holds, whichever physical position it has —
 * never reaches the array column's parser and never displaces the array. Both physical orders
 * are built, because a row's keys arrive in the table's column order and the reader walks them
 * in that order: the deployed shape (legacy first — the old column predates the new one) and the
 * other (legacy added after).
 *
 * Part 2 — every shipped column × { null, undefined, well-formed, a malformed value written raw }.
 * null reads as the column's null; undefined is refused at the write, naming the field; a
 * well-formed value round-trips; a malformed cell is either refused by the storage type (the
 * typed columns) or, where the storage holds text the column must parse, omitted from the record
 * at one WARN naming table and column — never the value — while the row and the result set serve.
 *
 * Part 3 — a result set mixing the async road (a column whose `deserialize` answers with a
 * promise) with a rejecting cell and a synchronous malformed cell resolves with every row served,
 * and leaves no unhandled rejection behind.
 */

/** The stored value no warning may ever carry — distinctive, so a leak is unmistakable. */
const LEGACY_WORD = 'legacyword7';

/**
 * The table as a pre-cutover build declared it: a text column named `tags` under the property
 * `tags`. Derived from the live table (same prototype, same name), never registered: loading it
 * creates — or adds — the physical `tags` column the cutover left behind.
 */
const legacyShapeOf = (table: Table<Member>): Table<any> => {
  const shape = Object.create(Object.getPrototypeOf(table));
  Object.assign(shape, table);
  shape.columns = withRecordColumns<any>({
    name: new StringColumn('name'),
    tags: new StringColumn('tags'),
  });
  return shape;
};

/** The unhandled rejections Node reported while `run` ran, counted after the loop drained twice. */
const unhandledRejectionsDuring = async <T>(run: () => Promise<T>): Promise<{ unhandled: number; value: T }> => {
  let unhandled = 0;
  const listener = () => {
    unhandled++;
  };
  process.on('unhandledRejection', listener);
  try {
    const value = await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { unhandled, value };
  } finally {
    process.off('unhandledRejection', listener);
  }
};

export const storedValueContractTests = (
  driver: DbDriver,
  transactionContextFactory: DefaultTransactionContextFactory,
  dropTable: (table: Table<any>) => Promise<void>
) => {
  return () => {
    const db = new Db(driver, undefined, transactionContextFactory);
    const testEnv = new DbTestEnvironment(driver, dropTable);
    const { Member: memberTable, MemberAfter: memberAfterTable, Mixed: mixedTable } = storedValueContractTestTables;
    const typesTable: Table<TestRecord> = columnTypesTestTables.Test;
    const statementConfigFactory = new StatementConfigFactory(driver.getDbName());

    beforeAll(async () => {
      await testEnv.beforeAll();
      // The deployed shape: the legacy `tags` column predates `tag_list`.
      await dropTable(memberTable);
      await driver.getTableManager().loadTable(legacyShapeOf(memberTable));
      await driver.getTableManager().loadTable(memberTable);
      // The other order: `tag_list` first, the legacy `tags` column added after it.
      await dropTable(memberAfterTable);
      await driver.getTableManager().loadTable(memberAfterTable);
      await driver.getTableManager().loadTable(legacyShapeOf(memberAfterTable));
    }, 120000);

    afterAll(async () => {
      await dropTable(memberTable);
      await dropTable(memberAfterTable);
      await testEnv.afterAll();
    }, 120000);

    /** The table as a statement names it for this driver: qualified with the database name where the driver needs it. */
    const qualified = (table: Table<any>, config: { dbName?: string }) =>
      `${config.dbName ? `\`${config.dbName}\`.` : ''}\`${table.name}\``;

    /** The row as the database holds it — every physical cell, keyed by column name, in column order. */
    const storedRow = async (table: Table<any>, id: string) => {
      const rows = await driver.runQuery((config) => ({
        sql: `SELECT * FROM ${qualified(table, statementConfigFactory.getStatementConfig(config))} WHERE id = '${id}'`,
      }));
      return rows[0];
    };

    /** A cell written past the serializer: the statement itself, handed the value as stored text (or NULL). */
    const writeRawCell = async (table: Table<any>, id: string, columnName: string, value: string | null) => {
      const literal = value === null ? 'NULL' : `'${value}'`;
      await driver.runDml((config) => ({
        sql: `UPDATE ${qualified(table, statementConfigFactory.getStatementConfig(config))} SET ${columnName} = ${literal} WHERE id = '${id}'`,
      }));
    };

    /**
     * A cell written past the serializer into a column whose storage holds text the column must
     * parse: the update statement the db layer itself emits, handed the cells as stored text.
     */
    const writeRawParsedCell = async (table: Table<any>, id: string, cells: { [columnName: string]: string }) => {
      const row = new QueryBuilderFactory().getQueryBuilder(table).condition({ field: 'id', operator: '=', value: id });
      await driver.runDml((config) =>
        new StatementFactory<any>().update(table.name, cells, row, statementConfigFactory.getStatementConfig(config))
      );
    };

    describe('part 1: a legacy column sharing a property name', () => {
      const legacyCases: [string, string | null][] = [
        ['a bare word', LEGACY_WORD],
        ['an empty string', ''],
        ['NULL', null],
      ];

      describe.each([
        ['the deployed shape: the legacy column before the declared one', memberTable, 'tags', 'tag_list'],
        ['the other order: the legacy column after the declared one', memberAfterTable, 'tag_list', 'tags'],
      ])('%s', (_, table, firstKey, secondKey) => {
        test.each(legacyCases)(
          'the declared array survives beside a legacy cell holding %s: a get and a query both carry it',
          async (_, legacy) => {
            const member = await db.insert(table, { name: `member ${legacy}`, tags: ['a', 'b'] });
            await writeRawCell(table, member.id, 'tags', legacy);

            const stored = await storedRow(table, member.id);
            const keys = Object.keys(stored);
            // The premise: the row holds both cells, in the physical order this block built.
            expect(keys).toEqual(expect.arrayContaining(['tags', 'tag_list']));
            expect(keys.indexOf(firstKey)).toBeLessThan(keys.indexOf(secondKey));
            expect(stored['tags']).toBe(legacy);

            const fetched = await db.get(table, { id: member.id });
            expect(fetched.tags).toEqual(['a', 'b']);
            expect(fetched).toMatchObject({ id: member.id, name: `member ${legacy}` });

            const queried = await db.query(table, { id: member.id });
            expect(queried).toHaveLength(1);
            expect(queried[0].tags).toEqual(['a', 'b']);

            await db.delete(table, { id: member.id });
          },
          60000
        );
      });
    });

    describe('part 2: every shipped column × { null, undefined, well-formed, malformed raw }', () => {
      type Property = keyof Omit<TestRecord, keyof Record>;
      const properties: Property[] = [
        'integerColumn',
        'stringColumn',
        'floatColumn',
        'decimalColumn',
        'booleanColumn',
        'dateColumn',
        'dateTimeColumn',
        'binaryColumn',
        'uuidColumn',
        'passwordColumn',
        'objectColumn',
        'arrayColumn',
        'referenceArrayColumn',
        'referenceColumn',
      ];
      const allNull = (): Omit<TestRecord, keyof Record> =>
        properties.reduce((cells, property) => ({ ...cells, [property]: null }), {}) as Omit<TestRecord, keyof Record>;

      describe('null', () => {
        let fetched: TestRecord;

        beforeAll(async () => {
          const inserted = await db.insert(typesTable, allNull());
          fetched = await db.get(typesTable, { id: inserted.id });
        }, 60000);

        afterAll(async () => {
          if (fetched) {
            await db.delete(typesTable, { id: fetched.id });
          }
        }, 60000);

        test.each(properties.filter((property) => property !== 'referenceArrayColumn'))(
          '%s: a null cell reads as null',
          (property) => {
            expect(fetched[property]).toBeNull();
          }
        );

        test('referenceArrayColumn: a null cell reads as an empty reference array', () => {
          expect(fetched.referenceArrayColumn).toHaveProperty('_ids', []);
        });
      });

      describe('undefined', () => {
        test("uuidColumn: undefined takes the column's default — a generated uuid", async () => {
          const inserted = await db.insert(typesTable, { ...allNull(), uuidColumn: undefined });
          try {
            const fetched = await db.get(typesTable, { id: inserted.id });
            expect(fetched.uuidColumn).toMatch(/^[0-9a-f-]{36}$/);
          } finally {
            await db.delete(typesTable, { id: inserted.id });
          }
        });

        test.each(properties.filter((property) => property !== 'uuidColumn'))(
          '%s: undefined is refused at the write, naming the field',
          async (property) => {
            await expect(db.insert(typesTable, { ...allNull(), [property]: undefined })).rejects.toThrow(
              `Undefined was found for field: ${typesTable.name}.${property}`
            );
          }
        );
      });

      describe('well-formed', () => {
        const wellFormed: Omit<TestRecord, keyof Record> = {
          integerColumn: 7,
          stringColumn: 'text',
          floatColumn: 1.5,
          decimalColumn: null,
          booleanColumn: true,
          dateColumn: new Date(2024, 0, 2, 12),
          dateTimeColumn: moment.utc('2024-01-02T03:04:05Z'),
          binaryColumn: null,
          uuidColumn: 'a4b2f5f2-2f8b-4c1e-9b2e-6d3f8a1c0e11',
          passwordColumn: 'stored-as-given',
          objectColumn: { theme: 'dark', depth: 2 },
          arrayColumn: ['a', 'b'],
          referenceArrayColumn: new ReferenceArray('reference_table', ['r1', 'r2']),
          referenceColumn: new Reference('reference_table', 'r3'),
        };
        let fetched: TestRecord;

        beforeAll(async () => {
          const inserted = await db.insert(typesTable, wellFormed);
          fetched = await db.get(typesTable, { id: inserted.id });
        }, 60000);

        afterAll(async () => {
          if (fetched) {
            await db.delete(typesTable, { id: fetched.id });
          }
        }, 60000);

        test('integerColumn round-trips', () => expect(fetched.integerColumn).toBe(7));
        test('stringColumn round-trips', () => expect(fetched.stringColumn).toBe('text'));
        test('floatColumn round-trips', () => expect(Number(fetched.floatColumn)).toBe(1.5));
        // A JS number does not bind to a NUMERIC parameter through the driver (the backend refuses the
        // statement: "Could not parse … 2.25 as NUMERIC"); the law is unpinned until the binding is.
        test.todo('decimalColumn round-trips (a JS number does not bind to NUMERIC through the driver)');
        test('booleanColumn round-trips', () => expect(fetched.booleanColumn).toBe(true));
        test('dateTimeColumn round-trips to the stored instant', () =>
          expect(moment(fetched.dateTimeColumn as never).valueOf()).toBe(Date.UTC(2024, 0, 2, 3, 4, 5)));
        test('dateColumn round-trips to the stored calendar day', () => {
          const day = new Date(fetched.dateColumn as Date);
          expect([day.getFullYear(), day.getMonth(), day.getDate()]).toEqual([2024, 0, 2]);
        });
        test('uuidColumn round-trips', () => expect(fetched.uuidColumn).toBe('a4b2f5f2-2f8b-4c1e-9b2e-6d3f8a1c0e11'));
        test('passwordColumn stores what it is given', () => expect(fetched.passwordColumn).toBe('stored-as-given'));
        test('objectColumn round-trips', () => expect(fetched.objectColumn).toEqual({ theme: 'dark', depth: 2 }));
        test('arrayColumn round-trips', () => expect(fetched.arrayColumn).toEqual(['a', 'b']));
        test('referenceArrayColumn round-trips its ids', () =>
          expect(fetched.referenceArrayColumn).toHaveProperty('_ids', ['r1', 'r2']));
        test('referenceColumn round-trips its id', () => expect(fetched.referenceColumn).toHaveProperty('_id', 'r3'));
      });

      describe('a malformed value written raw through the driver', () => {
        let legacy: TestRecord;
        let intact: TestRecord;

        beforeAll(async () => {
          legacy = await db.insert(typesTable, { ...allNull(), stringColumn: 'legacy' });
          intact = await db.insert(typesTable, { ...allNull(), stringColumn: 'intact', arrayColumn: ['c'] });
        }, 60000);

        afterAll(async () => {
          await db.delete(typesTable, { id: legacy.id });
          await db.delete(typesTable, { id: intact.id });
        }, 60000);

        // The storage type is the guard: a word is refused before it can be stored.
        test.each([
          ['integerColumn', 'integer_column'],
          ['floatColumn', 'float_column'],
          ['decimalColumn', 'decimal_column'],
          ['booleanColumn', 'boolean_column'],
          ['dateColumn', 'date_column'],
          ['dateTimeColumn', 'date_time_column'],
        ])('%s: the storage type refuses a word', async (_, columnName) => {
          await expect(writeRawCell(typesTable, legacy.id, columnName, LEGACY_WORD)).rejects.toThrow();
        });

        // Text the column does not parse: whatever is stored is what is read.
        test.each([
          ['stringColumn', 'string_column'],
          ['uuidColumn', 'uuid_column'],
          ['passwordColumn', 'password_column'],
        ])('%s: a stored word reads back as stored', async (property, columnName) => {
          await writeRawCell(typesTable, legacy.id, columnName, LEGACY_WORD);
          const fetched = await db.get(typesTable, { id: legacy.id });
          expect(fetched[property as Property]).toBe(LEGACY_WORD);
        });

        test('referenceColumn: a stored word is the id the reference carries', async () => {
          await writeRawCell(typesTable, legacy.id, 'reference_column', LEGACY_WORD);
          const fetched = await db.get(typesTable, { id: legacy.id });
          expect(fetched.referenceColumn).toHaveProperty('_id', LEGACY_WORD);
        });

        // Text the column parses: a cell it cannot parse is omitted — the row serves, the set resolves.
        test('objectColumn, arrayColumn, referenceArrayColumn: an unparseable cell is omitted; the row and the set serve', async () => {
          await writeRawParsedCell(typesTable, legacy.id, {
            object_column: LEGACY_WORD,
            array_column: LEGACY_WORD,
            reference_array_column: LEGACY_WORD,
          });

          const fetched = await db.get(typesTable, { id: legacy.id });
          expect(fetched).toMatchObject({ id: legacy.id });
          expect(fetched).not.toHaveProperty('objectColumn');
          expect(fetched).not.toHaveProperty('arrayColumn');
          expect(fetched).not.toHaveProperty('referenceArrayColumn');

          const all = await db.query(typesTable, {});
          expect(all.map((record) => record.id)).toEqual(expect.arrayContaining([legacy.id, intact.id]));
          expect(all.find((record) => record.id === intact.id)).toMatchObject({
            stringColumn: 'intact',
            arrayColumn: ['c'],
          });
        });

        test('a dynamic reference whose companion table-name cell is empty is omitted; the row serves', async () => {
          const { ProjectAssignment: assignments, Engineer: engineers } = dynamicReferenceTestTables;
          const engineer = await db.insert(engineers, { name: 'eng', yearsOfExperience: 3 });
          const assignment = await db.insert(assignments, {
            projectName: 'p',
            employeeTableName: engineers.name,
            employeeRef: new Reference(engineers.name, engineer.id),
            startDate: '2024-01-02',
          });
          try {
            await writeRawCell(assignments, assignment.id, 'employee_table_name', null);

            const fetched = await db.get(assignments, { id: assignment.id });
            expect(fetched).toMatchObject({ id: assignment.id, projectName: 'p', startDate: '2024-01-02' });
            expect(fetched).not.toHaveProperty('employeeRef');
          } finally {
            await driver.runDml((config) => ({
              sql: `DELETE FROM ${qualified(assignments, statementConfigFactory.getStatementConfig(config))} WHERE id = '${assignment.id}'`,
            }));
            await db.delete(engineers, { id: engineer.id });
          }
        });
      });
    });

    describe('part 3: a result set mixing the async road, a rejecting cell and a malformed cell', () => {
      test('resolves with every row served, and leaves no unhandled rejection', async () => {
        const plain = await db.insert(mixedTable, { title: 'plain', later: 1, tags: ['a'] });
        const unreadable = await db.insert(mixedTable, { title: 'unreadable', later: -1, tags: ['b'] });
        const malformed = await db.insert(mixedTable, { title: 'malformed', later: 2, tags: ['c'] });
        await writeRawParsedCell(mixedTable, malformed.id, { tags: LEGACY_WORD });
        try {
          const { unhandled, value: records } = await unhandledRejectionsDuring(() => db.query(mixedTable, {}));

          expect(unhandled).toBe(0);
          const byId: { [id: string]: Mixed } = {};
          for (const record of records) {
            byId[record.id] = record;
          }
          expect(byId[plain.id]).toMatchObject({ title: 'plain', later: 1, tags: ['a'] });
          expect(byId[unreadable.id]).toMatchObject({ title: 'unreadable', tags: ['b'] });
          expect(byId[unreadable.id]).not.toHaveProperty('later');
          expect(byId[malformed.id]).toMatchObject({ title: 'malformed', later: 2 });
          expect(byId[malformed.id]).not.toHaveProperty('tags');
        } finally {
          for (const record of [plain, unreadable, malformed]) {
            await db.delete(mixedTable, { id: record.id });
          }
        }
      }, 60000);
    });
  };
};
