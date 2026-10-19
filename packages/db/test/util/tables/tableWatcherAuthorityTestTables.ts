import { StringColumn, Table, withRecordColumns, Record } from '@proteinjs/db';

// --- Table watchers run with the authority of the write that fired them (WatchedNote -> GuardedJournal)

/** The watched table: a plain row whose writes fire the suite's journaling watcher. */
export interface WatchedNote extends Record {
  title: string;
}

/** The watcher's journal: one row per hook run, writable and readable as system only. */
export interface GuardedJournal extends Record {
  /** The watched row's id. */
  note: string;
  /** The hook that wrote the row (`beforeInsert` … `afterDelete`). */
  hook: string;
  /** The scoped-table contract in miniature — see {@link GuardedJournalTable}. */
  principal: string;
}

const WATCHED_NOTE_TABLE = 'db_test_tw_notes';
const GUARDED_JOURNAL_TABLE = 'db_test_tw_guarded_journal';

/** The journal's refusal of a non-system write or query, by name. */
export const WATCHER_GUARDED_REFUSAL = 'no user in scope (journal)';

export class WatchedNoteTable extends Table<WatchedNote> {
  name = WATCHED_NOTE_TABLE;
  columns: Table<WatchedNote>['columns'] = withRecordColumns<WatchedNote>({
    title: new StringColumn('title'),
  });
}

/**
 * A scoped table's shape without a dependency on one: a non-system write needs the context's
 * user to stamp the row with, a non-system query needs it to scope the query to — there is none
 * in a session-less context, so both refuse by name. A system write supplies the principal itself
 * and a system query is not scoped, exactly as `@proteinjs/user`'s ScopedRecord columns behave.
 */
export class GuardedJournalTable extends Table<GuardedJournal> {
  name = GUARDED_JOURNAL_TABLE;
  columns: Table<GuardedJournal>['columns'] = withRecordColumns<GuardedJournal>({
    note: new StringColumn('note'),
    hook: new StringColumn('hook'),
    principal: new StringColumn('principal', {
      defaultValue: async () => {
        throw new Error(WATCHER_GUARDED_REFUSAL);
      },
      forceDefaultValue: (runAsSystem) => !runAsSystem,
      addToQuery: async (qb, runAsSystem) => {
        if (!runAsSystem) {
          throw new Error(WATCHER_GUARDED_REFUSAL);
        }
      },
    }),
  });
}

export const tableWatcherAuthorityTestTables = {
  WatchedNote: new WatchedNoteTable() as Table<WatchedNote>,
  GuardedJournal: new GuardedJournalTable() as Table<GuardedJournal>,
};
