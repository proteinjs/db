import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';

/**
 * Tables for `DurableTableDoors.test.ts` (a durable table's delete door on the service and
 * caller-db paths).
 *
 * Defined here rather than in the test file so the reflection build registers them as `Table`
 * loadables — `tableByName` (which the db-service singleton and the `Table` wire serializer both
 * resolve through) must be able to find them for the test's RPC-boundary simulation.
 */

export interface LedgerEntry extends Record {
  title: string;
}

/** Every door open to any signed-in caller — the delete door included. */
export class DeletableLedgerEntryTable extends Table<LedgerEntry> {
  public name = 'db_test_deletable_ledger_entry';
  public auth: Table<LedgerEntry>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
  };
  public columns = withRecordColumns<LedgerEntry>({
    title: new StringColumn('title'),
  });
}

/** The same doors, declared durable: the declared delete doors do not reopen what durability closes. */
export class DurableLedgerEntryTable extends Table<LedgerEntry> {
  public name = 'db_test_durable_ledger_entry';
  public durable = true;
  public auth: Table<LedgerEntry>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
  };
  public columns = withRecordColumns<LedgerEntry>({
    title: new StringColumn('title'),
  });
}
