/**
 * `@proteinjs/db/source` — the server-only half of the source-record sync: the runner behind
 * `Db.init`'s source-record leg. It reads package.json files off the booting process (the
 * version stamp on every row it writes), so it never rides the package's browser index; a
 * server's boot imports this subpath once, which registers the runner as the package's
 * `SourceRecordSync` — the seam `Db.init` and the pre-schema-sync migration phase resolve through
 * reflection. A test harness that runs one boot of the sync directly imports the runner from here.
 */
export * from './SourceRecordSyncRunner';
