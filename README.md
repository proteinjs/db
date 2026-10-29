# Overview

## Source records: the full loop

A **source record** is a row a package declares in code (`SourceRecordLoader`) or in a
**declaration file** (`SourceRecordDeclarationFile`, pointing a table at a JSON document); the
sync (`SourceRecordSyncRunner`, behind `@proteinjs/db/source`) reconciles the table to its
declarations at boot (`Db.init`). Rows are matched by the table's key (`id`, or
`sourceRecordOptions.naturalKey` — scoped by a second column with `naturalKeyScope`, so a
registry keyed `(scope, name)` may hold one `name` per scope; the unique index is then the pair).

**Authorship is the rule.** The sync stamps every row it writes (`declaration_stamp`: the
declared columns and a digest of their values as written). A row still matching its stamp is
the *declaration's* — the sync inserts, updates and removes those. A row the product edited on a
declared column since the sync wrote it is the *product's*: the sync never touches it while the
declaration stands still (counted `kept`), re-adopts it — stamped, nothing else written — when
the declaration comes to equal it, and when BOTH moved to different values counts the row
`diverged`, leaves it untouched and warns once with both digests (never a failed boot; the
consumer's own reconcile settles it). A row the sync never wrote is never taken over through a
natural key (`refused`); a declared id, minted by the declaration, still claims a runtime row
holding it. Runtime-owned columns a declaration never covers can be written freely without
moving a row's authorship. Each load logs one line per table — counts only. A second load of
the same declaration changes nothing. A load that would remove more than the table's
`maxRemovedFraction` (default: more than half, and more than one row) refuses before touching
anything — the guard against a wrong or empty declaration.

**The export door.** `SourceRecordExportService.export(tableName)` renders a table's rows back
into a declaration: the key (and its scope), the columns the table lists in
`sourceRecordOptions.declarationColumns` (a column not listed — a secret — never leaves), every
row within `sourceRecordOptions.declarationFilter` (an equality filter — one scope's rows, say;
a file carrying a row outside it is refused), and a header naming the environment
(`SourceRecordExportConfigFactory`, the consumer's own loadable) and the export time. A column
listed in `sourceRecordOptions.externalColumns` (a long text — an instruction in markdown) is
returned as a sibling file beside the document (`<scope>/<key>/<column>.md`, the row carrying
the path), so its change reads as prose in a review and loads back byte for byte. The door sits
behind the permission slug `source-records-export`; the consumer maps the slug to roles (admin
passes as break-glass). Unmapped, it is admin-only.

**The pull command.** `source-records pull --from <base url> --table <name> --out <file>` calls
the export door with the consumer's own session — `SOURCE_RECORDS_COOKIE` (a `Cookie` header
value) or `SOURCE_RECORDS_BEARER` (a bearer token), never printed — and writes the document
byte-stably (sorted keys, rows sorted by the key, a trailing newline) with the sibling files
beside it. A re-pull whose rows and siblings did not change leaves them untouched, header time
included: a no-op diff.

So a consumer keeps a table's rows as a committed file: declare the file, edit rows in the
product, pull, review the diff, commit. Every fresh database loads the file; every existing one
keeps its own product-authored rows and follows the file for the rest.

