import { ArrayColumn, IntegerColumn, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';

/**
 * A table whose `tags` property moved from a text column named `tags` to an array column named
 * `tag_list` — the cutover shape: the new column added beside the old one (a column cannot be
 * retyped in place), the old one left physically present and undeclared. A stored row then holds
 * BOTH a `tags` cell and a `tag_list` cell, and the stored key `tags` is also the property's name.
 */
export interface Member extends Record {
  name: string;
  tags?: string[] | null;
}

/** The current declaration: `tags` lives in `tag_list`. */
export class MemberTable extends Table<Member> {
  public name = 'db_test_svc_member';
  public columns = withRecordColumns<Member>({
    name: new StringColumn('name'),
    tags: new ArrayColumn<string>('tag_list'),
  });
}

/** The same declaration for a second table, so the two physical column orders can each be built. */
export class MemberAfterTable extends Table<Member> {
  public name = 'db_test_svc_member_after';
  public columns = withRecordColumns<Member>({
    name: new StringColumn('name'),
    tags: new ArrayColumn<string>('tag_list'),
  });
}

/**
 * A column whose `deserialize` answers with a promise (the async road a stored cell can take):
 * resolves the stored number, rejects for the sentinel `-1` — a cell the column cannot read.
 */
export class LaterColumn extends IntegerColumn {
  deserialize(storedValue: number | null): Promise<number | null> {
    return storedValue === -1 ? Promise.reject(new RangeError('unreadable')) : Promise.resolve(storedValue);
  }
}

/** A row mixing the async road (`later`) with synchronous JSON cells (`tags`). */
export interface Mixed extends Record {
  title: string;
  later?: number | null;
  tags?: string[] | null;
}

export class MixedTable extends Table<Mixed> {
  public name = 'db_test_svc_mixed';
  public columns = withRecordColumns<Mixed>({
    title: new StringColumn('title'),
    later: new LaterColumn('later'),
    tags: new ArrayColumn<string>('tags'),
  });
}

export const storedValueContractTestTables = {
  Member: new MemberTable() as Table<Member>,
  MemberAfter: new MemberAfterTable() as Table<Member>,
  Mixed: new MixedTable() as Table<Mixed>,
};
