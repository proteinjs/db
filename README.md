# Overview

## Source records: the full loop

A **source record** is a row a package declares in code (`SourceRecordLoader`) or in a
**declaration file** (`SourceRecordDeclarationFile`, pointing a table at a JSON document); the
loader reconciles the table to its declarations at boot (`Db.init`). Rows are matched by the
table's key (`id`, or `sourceRecordOptions.naturalKey`).

**Authorship is the rule.** The loader stamps every row it writes (`declaration_stamp`: the
declared columns and a digest of their values as written). A row still matching its stamp is
the *declaration's* — the loader inserts, updates and removes those. A row the product created,
or edited on a declared column since the loader wrote it, is the *product's* — the loader never
touches it, whatever the declaration says (a product row that already equals its declaration is
adopted in place: stamped, nothing else written). Runtime-owned columns a declaration never
covers can be written freely without moving a row's authorship. Each load logs one line per
table — counts only: inserted · updated · unchanged · adopted · removed · kept. A second load of
the same declaration changes nothing. A load that would remove more than the table's
`maxRemovedFraction` (default: more than half, and more than one row) refuses before touching
anything — the guard against a wrong or empty declaration.

**The export door.** `SourceRecordExportService.export(tableName)` renders a table's rows back
into a declaration: the key, the columns the table lists in `sourceRecordOptions.declarationColumns`
(a column not listed — a secret — never leaves), every row, and a header naming the environment
(`SourceRecordExportConfigFactory`, the consumer's own loadable) and the export time. It sits
behind the permission slug `source-records-export`; the consumer maps the slug to roles
(admin passes as break-glass). Unmapped, it is admin-only.

**The pull command.** `source-records pull --from <base url> --table <name> --out <file>` calls
the export door with the consumer's own session — `SOURCE_RECORDS_COOKIE` (a `Cookie` header
value) or `SOURCE_RECORDS_BEARER` (a bearer token), never printed — and writes the file
byte-stably (sorted keys, rows sorted by the key, a trailing newline). A re-pull whose rows did
not change leaves the file untouched, header time included: a no-op diff.

So a consumer keeps a table's rows as a committed file: declare the file, edit rows in the
product, pull, review the diff, commit. Every fresh database loads the file; every existing one
keeps its own product-authored rows and follows the file for the rest.
