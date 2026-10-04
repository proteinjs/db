import { Migration, QueryBuilderFactory, SourceRecordLoader, getDbAsSystem, tables as dbTables } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { Setting } from '../tables/SettingTable';
import { tables } from '../tables/tables';

/**
 * The data step a database that predates the one-row-per-name invariant takes: before the unique
 * index over (scope, name) lands (schema sync's preflight refuses the index over duplicate rows),
 * keep ONE row of every (scope, name) — the newest, by `updated`, then `created`, then id — and
 * delete the rest. The surplus rows are the ones an update-then-insert `set` created under
 * concurrent writers; the newest holds the last value written, which is what the one row keeps.
 *
 * Pre-schema-sync (runs at `Db.init`, before the DDL), so by that contract: idempotent (a second
 * run finds no duplicates), tolerant of concurrent duplicate runs (every actor computes the same
 * survivors and deletes by id; a row already gone deletes nothing), and a no-op on a fresh
 * database whose setting table does not exist yet.
 */
export class DeduplicateSettingRows implements SourceRecordLoader<Migration> {
  /** Spanner binds at most 950 parameters to one statement; a delete names fewer ids than that. */
  private static readonly DELETE_BATCH = 500;

  table = dbTables.Migration;
  record = {
    id: 'a95d9f1d-3760-43d3-af75-15b0f7964eb6',
    description: 'Keep one setting row per scope and name (the newest) ahead of the unique index over them',
    preSchemaSync: true,
    estimate: async () => ({ units: (await this.surplusRowIds()).length, unit: 'rows' }),
    run: async () => {
      const surplus = await this.surplusRowIds();
      const db = getDbAsSystem<Setting>();
      for (let start = 0; start < surplus.length; start += DeduplicateSettingRows.DELETE_BATCH) {
        const batch = surplus.slice(start, start + DeduplicateSettingRows.DELETE_BATCH);
        const qb = new QueryBuilderFactory().getQueryBuilder(tables.Setting);
        qb.condition({ field: 'id', operator: 'IN', value: batch });
        await db.delete(tables.Setting, qb);
      }
      new Logger({ name: this.constructor.name }).info({
        message: 'Deleted the surplus setting rows',
        obj: { deleted: surplus.length },
      });
      return { deleted: surplus.length };
    },
  };

  /** The ids of every row that is not the newest of its (scope, name) — none when the table does not exist. */
  private async surplusRowIds(): Promise<string[]> {
    const db = getDbAsSystem<Setting>();
    if (!(await db.tableExists(tables.Setting))) {
      return [];
    }

    const rowsByKey: { [key: string]: Setting[] } = {};
    for (const row of await db.query(tables.Setting, {})) {
      const key = JSON.stringify([row.scope ?? null, row.name]);
      rowsByKey[key] = [...(rowsByKey[key] ?? []), row];
    }

    const surplus: string[] = [];
    for (const key of Object.keys(rowsByKey)) {
      const rows = rowsByKey[key];
      if (rows.length < 2) {
        continue;
      }
      rows.sort(DeduplicateSettingRows.newestFirst);
      surplus.push(...rows.slice(1).map((row) => row.id));
    }

    return surplus;
  }

  private static newestFirst(a: Setting, b: Setting): number {
    return (
      b.updated.valueOf() - a.updated.valueOf() ||
      b.created.valueOf() - a.created.valueOf() ||
      (b.id > a.id ? 1 : b.id < a.id ? -1 : 0)
    );
  }
}
