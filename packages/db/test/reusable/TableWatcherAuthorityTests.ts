import { Db, DbDriver, Table, TableWatcher, DefaultTransactionContextFactory } from '@proteinjs/db';
import { QueryBuilder } from '@proteinjs/db-query';
import { SourceRepository } from '@proteinjs/reflection';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import { TableWatcherRunner } from '../../src/TableWatcherRunner';
import {
  GuardedJournal,
  tableWatcherAuthorityTestTables,
  WATCHER_GUARDED_REFUSAL,
  WatchedNote,
} from '../util/tables/tableWatcherAuthorityTestTables';

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
type TableWatcherRunnerStatics = { tableWatcherMap?: unknown };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
const resetTableWatcherMap = () => {
  (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
};

/** The watcher's refusal when a hook arrives without the write's Db — the contract's first half. */
export const HOOK_HANDED_NO_DB = 'the hook was handed no Db';

const HOOKS = ['beforeInsert', 'afterInsert', 'beforeUpdate', 'afterUpdate', 'beforeDelete', 'afterDelete'];

/**
 * Journals every hook run through the HANDED Db and nothing else — the way a watcher is written
 * once the Db hands one (chat's topic watcher deleting a deleted message's topic links, the media
 * watcher deleting a deleted row's file, the activity watcher bumping the chat a message landed
 * in). The journal is a guarded table, so the hook's write and read succeed only with a system
 * Db: the one the write made, carrying its own authority.
 */
class JournalingWatcher implements TableWatcher<WatchedNote> {
  name(): string {
    return 'JournalingWatcher';
  }

  table(): Table<WatchedNote> {
    return tableWatcherAuthorityTestTables.WatchedNote;
  }

  async beforeInsert<T extends WatchedNote>(
    record: Omit<T, keyof WatchedNote>,
    db?: Db
  ): Promise<Omit<T, keyof WatchedNote>> {
    await this.journal(db, (record as unknown as WatchedNote).id, 'beforeInsert');
    return record;
  }

  async afterInsert<T extends WatchedNote>(record: T, db?: Db): Promise<void> {
    await this.journal(db, record.id, 'afterInsert');
  }

  async beforeUpdate<T extends WatchedNote>(record: Partial<T>, qb: QueryBuilder<T>, db?: Db): Promise<Partial<T>> {
    for (const row of await this.handed(db).query(this.table(), qb as unknown as QueryBuilder<WatchedNote>)) {
      await this.journal(db, row.id, 'beforeUpdate');
    }
    return record;
  }

  async afterUpdate<T extends WatchedNote>(
    recordUpdateCount: number,
    record: Partial<T>,
    qb: QueryBuilder<T>,
    db?: Db
  ): Promise<void> {
    for (const row of await this.handed(db).query(this.table(), qb as unknown as QueryBuilder<WatchedNote>)) {
      await this.journal(db, row.id, 'afterUpdate');
    }
  }

  async beforeDelete<T extends WatchedNote>(
    recordsToDelete: T[],
    _initialQb: QueryBuilder<T>,
    _deleteQb: QueryBuilder<T>,
    db?: Db
  ): Promise<void> {
    for (const row of recordsToDelete) {
      await this.journal(db, row.id, 'beforeDelete');
    }
  }

  async afterDelete<T extends WatchedNote>(
    _recordDeleteCount: number,
    deletedRecords: T[],
    _initialQb: QueryBuilder<T>,
    _deleteQb: QueryBuilder<T>,
    db?: Db
  ): Promise<void> {
    for (const row of deletedRecords) {
      await this.journal(db, row.id, 'afterDelete');
      // The read half of the contract: a query through the handed Db over the guarded table.
      await this.handed(db).query(tableWatcherAuthorityTestTables.GuardedJournal, { note: row.id });
    }
  }

  private async journal(db: Db | undefined, note: string, hook: string): Promise<void> {
    await this.handed(db).insert(tableWatcherAuthorityTestTables.GuardedJournal, {
      note,
      hook,
      principal: 'the write',
    });
  }

  private handed(db: Db | undefined): Db {
    if (!db) {
      throw new Error(HOOK_HANDED_NO_DB);
    }
    return db;
  }
}

/**
 * A table watcher's hooks run with the authority of the write that fired them: the Db hands every
 * hook a Db carrying its driver, tables, transaction context and system mode. Before this the
 * hooks were handed nothing and each watcher opened a session-scoped Db of its own, which a system
 * write in a session-less context (an account purge, a sweep) could not use — the topic links of a
 * purged message and the file of a system-deleted media row stayed behind, and the activity bump
 * of a system-inserted message threw.
 */
export const tableWatcherAuthorityTests = (
  driver: DbDriver,
  transactionContextFactory: DefaultTransactionContextFactory,
  dropTable: (table: Table<any>) => Promise<void>
) => {
  return () => {
    const testEnv = new DbTestEnvironment(driver, dropTable);
    const notes = tableWatcherAuthorityTestTables.WatchedNote;
    const journal = tableWatcherAuthorityTestTables.GuardedJournal;
    // Constructed in beforeAll, AFTER the watcher registration below: a Db's construction builds
    // the runner's static watcher map, and the map must be built from the registered watcher.
    let systemDb: Db;
    let sessionDb: Db;
    let originalWatchers: unknown[] | undefined;

    /** A fresh async hop — the shape of a background context that inherits no caller's state. */
    const inFreshContext = <T>(fn: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        setImmediate(() => {
          fn().then(resolve, reject);
        });
      });

    const journalHooksFor = async (noteId: string): Promise<string[]> =>
      (await systemDb.query(journal, { note: noteId })).map((row: GuardedJournal) => row.hook).sort();

    beforeAll(async () => {
      originalWatchers = objectCache()['@proteinjs/db/TableWatcher'];
      objectCache()['@proteinjs/db/TableWatcher'] = [new JournalingWatcher()];
      resetTableWatcherMap();
      systemDb = new Db(driver, undefined, transactionContextFactory, true);
      sessionDb = new Db(driver, undefined, transactionContextFactory);
      await testEnv.beforeAll();
    }, 120000);

    afterAll(async () => {
      await testEnv.afterAll();
      if (originalWatchers) {
        objectCache()['@proteinjs/db/TableWatcher'] = originalWatchers;
      } else {
        delete objectCache()['@proteinjs/db/TableWatcher'];
      }
      resetTableWatcherMap();
    }, 120000);

    beforeEach(async () => {
      await systemDb.delete(journal, {});
      await systemDb.delete(notes, {});
    });

    describe('Table watchers carry the write’s authority', () => {
      test('a system insert, update and delete in a session-less context: all six hooks write and read the guarded journal through the handed Db', async () => {
        const noteId = await inFreshContext(async () => {
          const note = await systemDb.insert(notes, { title: 'Kept' });
          await systemDb.update(notes, { title: 'Kept, renamed' }, { id: note.id });
          await systemDb.delete(notes, { id: note.id });
          return note.id;
        });

        expect(await systemDb.query(notes, { id: noteId })).toHaveLength(0);
        expect(await journalHooksFor(noteId)).toEqual([...HOOKS].sort());
      });

      test('a session write’s hooks run as the session, never as system: the guarded journal refuses the first hook and the write with it', async () => {
        await expect(sessionDb.insert(notes, { title: 'Refused' })).rejects.toThrow(WATCHER_GUARDED_REFUSAL);
        expect(await systemDb.query(notes, { title: 'Refused' })).toHaveLength(0);
      });

      test('the handed Db rides the write’s transaction: a rolled-back system insert leaves no journal row', async () => {
        let noteId: string | undefined;
        await expect(
          systemDb.runTransaction(async () => {
            const note = await systemDb.insert(notes, { title: 'Rolled back' });
            noteId = note.id;
            throw new Error('roll back');
          })
        ).rejects.toThrow('roll back');

        expect(noteId).toBeDefined();
        expect(await systemDb.query(notes, { id: noteId })).toHaveLength(0);
        expect(await journalHooksFor(noteId!)).toEqual([]);
      });
    });
  };
};
