import { inspect } from 'util';
import { Logger } from '@proteinjs/logger';
import { TableManager } from '../src/schema/TableManager';
import { Table } from '../src/Table';
import { ArrayColumn, StringColumn } from '../src/Columns';
import { Record, withRecordColumns } from '../src/Record';

/**
 * The census (`TableManager.warnUndeclaredColumns`): at every schema sync of an existing table,
 * the physical columns no declared column owns are named in ONE warning — a column a rename
 * retired (`tags` beside the `tag_list` that replaced it), a column the table dropped. Names
 * only: the warning carries no stored value (the census reads the schema, never a row).
 */

interface Member extends Record {
  name: string;
  tags: string[];
}

class MemberTable extends Table<Member> {
  public name = 'census_member';
  public columns = withRecordColumns<Member>({
    name: new StringColumn('name'),
    tags: new ArrayColumn<string>('tag_list'),
  });
}

type CapturedLog = { logLevel: string; message?: string; obj?: any };
type ManagerInternals = {
  logger: Logger;
  getTableChanges(table: Table<any>): Promise<unknown>;
  getIndexOperations(table: Table<any>): Promise<{ indexesToCreate: unknown[]; indexesToDrop: unknown[] }>;
};

const printedLine = (log: CapturedLog) => [log.message ?? '', inspect(log.obj, { depth: 10 })].join('\n');

describe('the undeclared-column census', () => {
  const table = new MemberTable() as Table<Member>;
  let captured: CapturedLog[];

  const managerOver = (physicalColumns: string[]) => {
    const columnMetadata: { [name: string]: { type: string; isNullable: boolean } } = {};
    for (const name of physicalColumns) {
      columnMetadata[name] = { type: 'STRING(MAX)', isNullable: true };
    }
    const manager = new TableManager(
      {} as never,
      { getType: () => 'STRING(MAX)' } as never,
      {} as never,
      {
        getColumnMetadata: async () => columnMetadata,
        getUniqueColumns: async () => [],
        getForeignKeys: async () => ({}),
      } as never
    );
    const internals = manager as unknown as ManagerInternals;
    internals.logger = new Logger({
      name: 'TableManager',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as never,
    });
    internals.getIndexOperations = async () => ({ indexesToCreate: [], indexesToDrop: [] });
    return internals;
  };

  beforeEach(() => {
    captured = [];
  });

  test('a physical column no declared column owns is named, once, with the table — names only', async () => {
    const manager = managerOver(['id', 'created', 'updated', 'name', 'tag_list', 'tags']);

    await manager.getTableChanges(table);

    const warnings = captured.filter((log) => log.logLevel === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].obj).toEqual({ table: 'census_member', columns: ['tags'] });
    expect(printedLine(warnings[0])).toContain('census_member');
  });

  test('a table whose every physical column is declared warns nothing', async () => {
    const manager = managerOver(['id', 'created', 'updated', 'name', 'tag_list']);

    await manager.getTableChanges(table);

    expect(captured.filter((log) => log.logLevel === 'warn')).toHaveLength(0);
  });
});
