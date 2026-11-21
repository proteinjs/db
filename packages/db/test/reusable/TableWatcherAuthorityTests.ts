import { Db, DbDriver, Reference, Table, TableWatcher, DefaultTransactionContextFactory } from '@proteinjs/db';
import { QueryBuilder } from '@proteinjs/db-query';
import { SourceRepository } from '@proteinjs/reflection';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import { TableWatcherRunner } from '../../src/TableWatcherRunner';
import { cascadeDeleteTestTables, Comment, Post } from '../util/tables/cascadeDeleteTestTables';
import {
  GuardedJournal,
  tableWatcherAuthorityTestTables,
  WATCHER_GUARDED_REFUSAL,
  WatchedNote,
} from '../util/tables/tableWatcherAuthorityTestTables';

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
type TableWatcherRunnerStatics = { tableWatcherMap?: { [tableName: string]: unknown } };
/** The line a Db's watcher runner logs when a watcher fails where the write may not. */
type DbInternals = {
  tableWatcherRunner: { logger: { error: (line: { message?: string; error?: unknown }) => void } };
};
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

/** What a watcher met when it was told its rows are durably deleted. */
type DurableDeleteTelling = {
  /** The rows it was told of. */
  ids: string[];
  /** How many of those rows a read through the handed Db still finds. */
  standing: number;
  /** Whether a transaction stood open around the telling. */
  inTransaction: boolean;
  /** The handed Db's mode: the invoking write's. */
  system: boolean;
};

/** The durable-delete cases' switches and what their watchers met: one object the suite and its watchers share. */
type DurableDeleteScene = {
  told: DurableDeleteTelling[];
  /** Times the after-delete hook was reached: a delete reaches it only once its cascades are through. */
  afterDeletes: number;
  /** Times the step's first watcher threw. */
  stepRefusals: number;
  refuseTheStep: boolean;
  refuseTheCascade: boolean;
  /** The posts a before-delete watcher takes out of a delete. */
  keep: string[];
};

/** The step's first watcher's throw, and the cascade's — the words the cases assert on. */
const DURABLE_DELETE_STEP_REFUSAL = 'the telling is refused';
const DURABLE_DELETE_CASCADE_REFUSAL = 'the cascade is refused';

/**
 * The FIRST watcher of the post table's durable-delete step: throws in it when the scene says so —
 * the shape of a telling that fails (a notifier whose transport is down).
 */
class RefusingDurableDeleteWatcher implements TableWatcher<Post> {
  constructor(private scene: DurableDeleteScene) {}

  name(): string {
    return 'RefusingDurableDeleteWatcher';
  }

  table(): Table<Post> {
    return cascadeDeleteTestTables.Post;
  }

  async afterDeleteDurable(): Promise<void> {
    if (this.scene.refuseTheStep) {
      this.scene.stepRefusals++;
      throw new Error(DURABLE_DELETE_STEP_REFUSAL);
    }
  }
}

/**
 * The watcher AFTER it: records each telling as it met it — the rows, what a read through the
 * handed Db still finds of them, whether a transaction stood open, the handed Db's mode — and
 * counts the after-delete hook.
 */
class RecordingDurableDeleteWatcher implements TableWatcher<Post> {
  constructor(
    private scene: DurableDeleteScene,
    private transactionContextFactory: DefaultTransactionContextFactory
  ) {}

  name(): string {
    return 'RecordingDurableDeleteWatcher';
  }

  table(): Table<Post> {
    return cascadeDeleteTestTables.Post;
  }

  async afterDelete(): Promise<void> {
    this.scene.afterDeletes++;
  }

  async afterDeleteDurable<T extends Post>(deletedRecords: T[], db?: Db): Promise<void> {
    if (!db) {
      throw new Error(HOOK_HANDED_NO_DB);
    }
    const ids = deletedRecords.map((row) => row.id);
    // Recorded before the read, so a telling whose read fails still shows (as -1 rows standing).
    const telling: DurableDeleteTelling = {
      ids,
      standing: -1,
      inTransaction: !!this.transactionContextFactory.getTransactionContext().currentTransaction,
      system: db.isSystem(),
    };
    this.scene.told.push(telling);
    const standing = await db.query(
      this.table(),
      new QueryBuilder<Post>(this.table().name).condition({ field: 'id', operator: 'IN', value: ids })
    );
    telling.standing = standing.length;
  }
}

/**
 * Takes the posts the scene names out of a delete, the way a before-delete hook does it: out of
 * the delete's statement and out of its list of rows (a watcher that archives a row a person
 * deletes instead of removing it).
 */
class KeepingWatcher implements TableWatcher<Post> {
  constructor(private scene: DurableDeleteScene) {}

  name(): string {
    return 'KeepingWatcher';
  }

  table(): Table<Post> {
    return cascadeDeleteTestTables.Post;
  }

  async beforeDelete<T extends Post>(
    recordsToDelete: T[],
    _initialQb: QueryBuilder<T>,
    deleteQb: QueryBuilder<T>
  ): Promise<void> {
    const kept = recordsToDelete.map((row) => row.id).filter((id) => this.scene.keep.includes(id));
    if (kept.length === 0) {
      return;
    }
    deleteQb.condition({ field: 'id', operator: 'NOT IN', value: kept as T[keyof T][] });
    for (let i = recordsToDelete.length - 1; i >= 0; i--) {
      if (kept.includes(recordsToDelete[i].id)) {
        recordsToDelete.splice(i, 1);
      }
    }
  }
}

/**
 * Refuses the delete of a comment when the scene says so: the post's reverse cascade then throws,
 * after the post's own delete statement has run.
 */
class RefusingCascadeWatcher implements TableWatcher<Comment> {
  constructor(private scene: DurableDeleteScene) {}

  name(): string {
    return 'RefusingCascadeWatcher';
  }

  table(): Table<Comment> {
    return cascadeDeleteTestTables.Comment;
  }

  async beforeDelete(): Promise<void> {
    if (this.scene.refuseTheCascade) {
      throw new Error(DURABLE_DELETE_CASCADE_REFUSAL);
    }
  }
}

/**
 * A table watcher's hooks run with the authority of the write that fired them: the Db hands every
 * hook a Db carrying its driver, tables, transaction context and system mode. Before this the
 * hooks were handed nothing and each watcher opened a session-scoped Db of its own, which a system
 * write in a session-less context (an account purge, a sweep) could not use — the topic links of a
 * purged message and the file of a system-deleted media row stayed behind, and the activity bump
 * of a system-inserted message threw.
 *
 * A watcher is also told when its rows are DURABLY deleted (`afterDeleteDurable`): right after the
 * rows' own delete statement, so a cascade that throws afterwards — leaving the rows deleted and
 * the after-delete hook unreached — no longer leaves it untold; inside a transaction only after
 * the commit, never after a rollback; and a watcher that throws there fails neither the delete nor
 * the watchers after it.
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
    const posts = cascadeDeleteTestTables.Post;
    const comments = cascadeDeleteTestTables.Comment;
    const scene: DurableDeleteScene = {
      told: [],
      afterDeletes: 0,
      stepRefusals: 0,
      refuseTheStep: false,
      refuseTheCascade: false,
      keep: [],
    };
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
      objectCache()['@proteinjs/db/TableWatcher'] = [
        new JournalingWatcher(),
        // In this order: the durable-delete step's first watcher is the one that can refuse it.
        new RefusingDurableDeleteWatcher(scene),
        new RecordingDurableDeleteWatcher(scene, transactionContextFactory),
        new RefusingCascadeWatcher(scene),
        new KeepingWatcher(scene),
      ];
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

    describe('A table watcher is told when its rows are durably deleted', () => {
      beforeEach(async () => {
        scene.refuseTheStep = false;
        scene.refuseTheCascade = false;
        scene.keep = [];
        await systemDb.delete(comments, {});
        await systemDb.delete(posts, {});
        // Emptied after the cleanup, whose own deletes are told too.
        scene.told = [];
        scene.afterDeletes = 0;
        scene.stepRefusals = 0;
      });

      test('a delete outside a transaction whose cascade throws: the watcher was told of the rows, and the rows are gone', async () => {
        const post = await sessionDb.insert(posts, { title: 'Deleted before its cascade' });
        const comment = await sessionDb.insert(comments, {
          text: 'Its delete is refused',
          postRef: new Reference<Post>(posts.name, post.id),
        });
        scene.refuseTheCascade = true;

        await expect(sessionDb.delete(posts, { id: post.id })).rejects.toThrow(DURABLE_DELETE_CASCADE_REFUSAL);

        // The post's own statement had run before the cascade threw: the post is gone, its comment
        // stands, and the after-delete hook was never reached.
        expect(await sessionDb.query(posts, { id: post.id })).toHaveLength(0);
        expect(await sessionDb.query(comments, { id: comment.id })).toHaveLength(1);
        expect(scene.afterDeletes).toBe(0);
        expect(scene.told).toEqual([{ ids: [post.id], standing: 0, inTransaction: false, system: false }]);
      });

      test('a delete inside a transaction that rolls back: the watcher is never told, and the rows stand', async () => {
        const post = await sessionDb.insert(posts, { title: 'Stands after the rollback' });

        await expect(
          sessionDb.runTransaction(async () => {
            await sessionDb.delete(posts, { id: post.id });
            throw new Error('roll back');
          })
        ).rejects.toThrow('roll back');

        expect(scene.told).toEqual([]);
        expect(await sessionDb.query(posts, { id: post.id })).toHaveLength(1);
      });

      test('a delete inside a transaction that commits: the watcher is told once, after the commit', async () => {
        const post = await systemDb.insert(posts, { title: 'Gone at the commit' });
        let deleted: number | undefined;
        let toldBeforeTheCommit: number | undefined;

        await systemDb.runTransaction(async () => {
          deleted = await systemDb.delete(posts, { id: post.id });
          toldBeforeTheCommit = scene.told.length;
        });

        expect(deleted).toBe(1);
        expect(toldBeforeTheCommit).toBe(0);
        expect(scene.told).toEqual([{ ids: [post.id], standing: 0, inTransaction: false, system: true }]);
        expect(await systemDb.query(posts, { id: post.id })).toHaveLength(0);
      });

      test('a watcher that throws in the step: the delete answers its count, the throw is logged with the watcher’s name, and the watchers after it are told', async () => {
        const post = await sessionDb.insert(posts, { title: 'Deleted all the same' });
        scene.refuseTheStep = true;
        const logged: { message?: string; error?: unknown }[] = [];
        const runnerLogger = (sessionDb as unknown as DbInternals).tableWatcherRunner.logger;
        const errorLine = jest.spyOn(runnerLogger, 'error').mockImplementation((line) => {
          logged.push(line);
        });

        let deleted: number;
        try {
          deleted = await sessionDb.delete(posts, { id: post.id });
        } finally {
          errorLine.mockRestore();
        }

        expect(deleted).toBe(1);
        expect(scene.stepRefusals).toBe(1);
        expect(logged).toHaveLength(1);
        expect(logged[0].message).toContain('RefusingDurableDeleteWatcher');
        expect((logged[0].error as Error).message).toBe(DURABLE_DELETE_STEP_REFUSAL);
        expect(scene.told).toEqual([{ ids: [post.id], standing: 0, inTransaction: false, system: false }]);
        expect(scene.afterDeletes).toBe(1);
        expect(await sessionDb.query(posts, { id: post.id })).toHaveLength(0);
      });

      test('the rows a before-delete watcher takes out of a delete are not told: the watcher hears of the rows left, and of nothing when none is left', async () => {
        const kept = await sessionDb.insert(posts, { title: 'Taken out of the delete' });
        const removed = await sessionDb.insert(posts, { title: 'Deleted' });
        scene.keep = [kept.id];

        expect(await sessionDb.delete(posts, {})).toBe(1);
        expect(scene.told).toEqual([{ ids: [removed.id], standing: 0, inTransaction: false, system: false }]);

        scene.told = [];
        expect(await sessionDb.delete(posts, { id: kept.id })).toBe(0);
        expect(scene.told).toEqual([]);
        expect(await sessionDb.query(posts, { id: kept.id })).toHaveLength(1);
      });

      test('a map entry seated by hand with no list for the step names no watcher to tell: a delete on its table runs as before', async () => {
        const map = (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap!;
        const standing = map[notes.name];
        // The six lists of the write hooks, as an entry was written before the step existed.
        map[notes.name] = {
          beforeInsert: [],
          afterInsert: [],
          beforeUpdate: [],
          afterUpdate: [],
          beforeDelete: [],
          afterDelete: [],
        };

        try {
          const note = await systemDb.insert(notes, { title: 'Deleted under a hand-seated entry' });
          expect(await systemDb.delete(notes, { id: note.id })).toBe(1);
          expect(await systemDb.query(notes, { id: note.id })).toHaveLength(0);
        } finally {
          map[notes.name] = standing;
        }
      });
    });
  };
};
