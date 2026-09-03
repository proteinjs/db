# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.18.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.17.1...@proteinjs/db-ui@1.18.0) (2026-09-03)


### Features

* **db-ui:** declared record-form panels — RecordPanel + the one-loader record page (plans/USAGE_SURFACES.md §B.1, US-1/US-2) ([dc72f63](https://github.com/proteinjs/db/commit/dc72f63ea25296ebaec22f9b06ed10b88c932b11))





## [1.17.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.17.0...@proteinjs/db-ui@1.17.1) (2026-09-02)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.17.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.16.2...@proteinjs/db-ui@1.17.0) (2026-09-02)


### Features

* **db, db-ui:** the Migrations ops table — name column, declared sort + labels, and the every-release `updated` re-stamp fixed at the source-record sync ([a961c6f](https://github.com/proteinjs/db/commit/a961c6f81710e3c03ab6ba0f2840a7c3f3d77d46))





## [1.16.2](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.16.1...@proteinjs/db-ui@1.16.2) (2026-09-02)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.16.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.16.0...@proteinjs/db-ui@1.16.1) (2026-09-02)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.16.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.15.2...@proteinjs/db-ui@1.16.0) (2026-09-01)


### Features

* record surfaces render what tables declare — declared row columns + auth-derived affordances ([cf5a62e](https://github.com/proteinjs/db/commit/cf5a62e73283720e40bae95e5957e282ffbf25b3))





## [1.15.2](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.15.1...@proteinjs/db-ui@1.15.2) (2026-08-31)


### Bug Fixes

* admin record surfaces take the full mobile view (founder finding 2026-08-31: the record table, record form, and tables browser rendered as floating cards on phones) — below the phone line RecordTablePage, RecordFormPage, and TablesPage drop the Paper/FormPage card and the page gutters: the surface fills the shell's page column under the default back-to-home chrome row (flex-grow 1 + min-height 0; the table's own scroll container carries the height, the form page scrolls itself and keeps a 16px content inset — the card's inset was all that kept fields off the glass). Desktop keeps the deliberate admin-round-3 house card unchanged. Red-before-green: the three phone-layout suites assert the full-bleed grammar (no MuiPaper, no gutter padding, flex-grow/min-height 0, phone card face) and FAILED at the pre-fix pages (Paper present, exact defect shape); 5 bite mutations (phone branch disabled on each page, gutter padding reintroduced, form overflow dropped) each failed exactly the guarding leg, restored green. db-ui 15 suites / 58 tests green (13/54 pre-existing; tablesPageMobile + recordFormPageMobile new, recordTablePageMobile rewritten to the ruling). Live proof at 375x812 both themes on an isolated estate (v1.20.1 shell + dedicated emulator): all three surfaces full-bleed under the back-to-home row with real rows; desktop cards byte-identical. ([f7b9c8f](https://github.com/proteinjs/db/commit/f7b9c8f83b0650173d285c16af423055e0291d0e))





## [1.15.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.15.0...@proteinjs/db-ui@1.15.1) (2026-08-31)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.15.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.14.0...@proteinjs/db-ui@1.15.0) (2026-08-29)


### Features

* unbounded text on record forms + admin scroll affordances (founder rulings, admin round 3) — AR-1: StringColumn drops the MAX-implies-ui.hidden default (the form renders any length safely now: multiline field, bounded preview + expand past the inline bound — a migration's failure stack is what the form gets opened to read); the record TABLE's default pick excludes unbounded plain text at the pick itself (explicit columns still honored, Object columns exempt), and an author's explicit ui.hidden still hides everywhere (data_encryption_key.wrapped_key declares it — key material, not prose). AR-2: the admin record scrollers adopt the house scroll-container behavior — TopScrollFade + ScrollTopButton on the record table page and the Tables browser via one adminScrollAffordances owner, with the back-to-top button reading the consumer theme's customShadows tokens (framework default when absent); db-ui floors @proteinjs/ui ^4.14.0 (topScrollFade). Red-before-green: StringColumnUiDefaults (2 red pre-fix), recordFormUnboundedText form legs (2 red pre-fix), table-pick exclusion verified red at the mid-state ([15b5419](https://github.com/proteinjs/db/commit/15b5419880f098a3b671c617a79466f1febd5c02))





# [1.14.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.13.1...@proteinjs/db-ui@1.14.0) (2026-08-29)


### Bug Fixes

* db-ui declares the @proteinjs/ui range it actually needs (^4.12.0) ([2f8773d](https://github.com/proteinjs/db/commit/2f8773d865f2b949fe3958a218a8c095cb477acf))


### Features

* record forms group their fields — derived sections (identity, content, details, system), a formGroup column hint, the record id back on the form, references as data ink ([8db7e79](https://github.com/proteinjs/db/commit/8db7e79facfc9899dcca018be561a2edda7fc404))





## [1.13.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.13.0...@proteinjs/db-ui@1.13.1) (2026-08-29)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.13.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.12.2...@proteinjs/db-ui@1.13.0) (2026-08-28)


### Features

* record table + form polish on the shared cell grammar — tiered meaningful-data default columns (name → identity strings → status-like → booleans → references, long text demoted, hidden columns never picked), per-type default renderers (references as linked record names via ReferenceCellValue, check/dash booleans, humanized dates, mono JSON snippets, quiet status chips, right-aligned numerics), plain strings ride the base defaults (card identity emphasis + empty-field omission), long-text and JSON form fields render multiline (JSON parsed on save with a field-named error), readonly timestamps compact with a relative helper, multiline fields take solo full-width form rows ([609991d](https://github.com/proteinjs/db/commit/609991d8f4b2949520b67050502ed1b7459be0e1))





## [1.12.2](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.12.1...@proteinjs/db-ui@1.12.2) (2026-08-28)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.12.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.12.0...@proteinjs/db-ui@1.12.1) (2026-08-26)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.12.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.11.3...@proteinjs/db-ui@1.12.0) (2026-08-26)


### Features

* record form field renderers — a customization can take over a field's slot with its own component ([8b7ff2a](https://github.com/proteinjs/db/commit/8b7ff2ab02f6bda908df03b09a618fa5da1b4513))





## [1.11.3](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.11.2...@proteinjs/db-ui@1.11.3) (2026-08-26)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.11.2](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.11.1...@proteinjs/db-ui@1.11.2) (2026-08-24)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.11.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.11.0...@proteinjs/db-ui@1.11.1) (2026-08-23)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.11.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.10.2...@proteinjs/db-ui@1.11.0) (2026-08-19)


### Features

* record table page phone layout — full-width card with page gutters (task [#53](https://github.com/proteinjs/db/issues/53)) ([43061ff](https://github.com/proteinjs/db/commit/43061ff77d1677ff9294006a00da71c46659c281))





## [1.10.2](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.10.1...@proteinjs/db-ui@1.10.2) (2026-08-19)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.10.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.10.0...@proteinjs/db-ui@1.10.1) (2026-08-18)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.10.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.9.4...@proteinjs/db-ui@1.10.0) (2026-08-17)


### Features

* **db:** retired-migration flag — the deploy series stamps source-less ledger rows and never auto-runs retired rows ([f468125](https://github.com/proteinjs/db/commit/f4681257439e2e7e031f9d7f4d90b7463cc46456))
* functional hardening for admin record surfaces — delete confirmation, type-truthful field controls, plural titles, tablesPage export ([4c3c5ad](https://github.com/proteinjs/db/commit/4c3c5adc29a4ceb4f1b5dd148a7fd4dd41f53172))





## [1.9.4](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.9.3...@proteinjs/db-ui@1.9.4) (2026-08-15)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.9.3](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.9.2...@proteinjs/db-ui@1.9.3) (2026-08-15)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.9.2](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.9.1...@proteinjs/db-ui@1.9.2) (2026-08-15)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.9.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.9.0...@proteinjs/db-ui@1.9.1) (2026-08-14)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.9.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.8.5...@proteinjs/db-ui@1.9.0) (2026-08-14)


### Features

* cursor-window paging owner; RecordIterator migrated off offset paging ([453c4a2](https://github.com/proteinjs/db/commit/453c4a2a5f87bd7b58b0042185100bcf9ae0e183))





## [1.8.5](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.8.4...@proteinjs/db-ui@1.8.5) (2026-08-14)


### Bug Fixes

* record table/form page error states + drop 100vh page pins ([6c6aca2](https://github.com/proteinjs/db/commit/6c6aca2cca754e8201011694da893dba2bbd6898))





## [1.8.4](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.8.3...@proteinjs/db-ui@1.8.4) (2026-08-14)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.8.3](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.8.2...@proteinjs/db-ui@1.8.3) (2026-08-14)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.8.2](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.8.1...@proteinjs/db-ui@1.8.2) (2026-08-13)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.8.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.8.0...@proteinjs/db-ui@1.8.1) (2026-08-13)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.8.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.7.1...@proteinjs/db-ui@1.8.0) (2026-08-13)


### Bug Fixes

* **ci:** db-ui rides @proteinjs/ui 4.6.0 — the Cursor* exports QueryCursorLoader imports ([540de28](https://github.com/proteinjs/db/commit/540de28b992eb6dadf8ca7a5f0f706394485aeba))


### Features

* QueryCursorLoader — cursor windows over the QueryBuilder machinery ([f45f3b3](https://github.com/proteinjs/db/commit/f45f3b32edae7c0e232574bd319522c277238116))





## [1.6.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.6.0...@proteinjs/db-ui@1.6.1) (2026-08-08)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.34](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.33...@proteinjs/db-ui@1.5.34) (2026-07-28)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.33](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.32...@proteinjs/db-ui@1.5.33) (2026-07-24)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.32](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.31...@proteinjs/db-ui@1.5.32) (2026-07-24)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.30](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.29...@proteinjs/db-ui@1.5.30) (2026-07-21)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.29](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.28...@proteinjs/db-ui@1.5.29) (2026-07-10)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.28](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.27...@proteinjs/db-ui@1.5.28) (2026-07-03)


### Bug Fixes

* remove leftover debug console.log firing on every RecordTable cell render ([6398849](https://github.com/proteinjs/db/commit/6398849ce563f6693f16f5f41d4a3851af994261))





## [1.5.26](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.25...@proteinjs/db-ui@1.5.26) (2026-04-18)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.21](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.20...@proteinjs/db-ui@1.5.21) (2026-04-08)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.20](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.19...@proteinjs/db-ui@1.5.20) (2026-04-07)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.18](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.17...@proteinjs/db-ui@1.5.18) (2026-03-06)


### Bug Fixes

* `RecordTable` should gracefully handle reference columns that for some reason don't identify as `ReferenceColumn` via `isInstanceOf`. ([83be615](https://github.com/proteinjs/db/commit/83be61590f63e71a49efe452cef4f6a9ec66f945))





## [1.5.16](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.15...@proteinjs/db-ui@1.5.16) (2026-02-12)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.15](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.14...@proteinjs/db-ui@1.5.15) (2025-11-22)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.12](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.11...@proteinjs/db-ui@1.5.12) (2025-11-13)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.11](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.10...@proteinjs/db-ui@1.5.11) (2025-11-08)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.9](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.8...@proteinjs/db-ui@1.5.9) (2025-09-28)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.8](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.7...@proteinjs/db-ui@1.5.8) (2025-09-24)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.6](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.5...@proteinjs/db-ui@1.5.6) (2025-09-09)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.5.5](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.5.4...@proteinjs/db-ui@1.5.5) (2025-08-20)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.5.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.4.0...@proteinjs/db-ui@1.5.0) (2025-04-24)


### Features

* Added `QueryOptions` to `Db.query`, `Db.get`, and `QueryTableLoader`. Specifically, added the `preloadReferences` option that enables the caller to specify how references (field values of type `Reference` and `ReferenceArray`) are preloaded. ([8f42373](https://github.com/proteinjs/db/commit/8f42373093eb42114de76bffbb7d735f5b33402c))





# [1.4.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.3.6...@proteinjs/db-ui@1.4.0) (2025-04-23)


### Features

* Added `/hash-generator` utility page ([d7ef6f0](https://github.com/proteinjs/db/commit/d7ef6f0b9b0fdf79517dea359820416372e8c654))





## [1.3.5](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.3.4...@proteinjs/db-ui@1.3.5) (2025-04-15)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.3.3](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.3.2...@proteinjs/db-ui@1.3.3) (2025-04-02)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.3.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.3.0...@proteinjs/db-ui@1.3.1) (2025-03-28)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.3.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.2.6...@proteinjs/db-ui@1.3.0) (2025-02-07)


### Features

* Dynamic reference column ([#12](https://github.com/proteinjs/db/issues/12)) ([554b2e4](https://github.com/proteinjs/db/commit/554b2e4159f1d692d2ae976461c60f88639ecf22))





## [1.2.6](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.2.5...@proteinjs/db-ui@1.2.6) (2024-12-11)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.2.5](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.2.4...@proteinjs/db-ui@1.2.5) (2024-12-10)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.2.4](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.2.3...@proteinjs/db-ui@1.2.4) (2024-11-07)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.2.3](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.2.2...@proteinjs/db-ui@1.2.3) (2024-11-06)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.2.2](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.2.1...@proteinjs/db-ui@1.2.2) (2024-10-31)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.2.1](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.2.0...@proteinjs/db-ui@1.2.1) (2024-10-21)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.2.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.24...@proteinjs/db-ui@1.2.0) (2024-09-27)


### Features

* table updates; RecordIterator accepts optional db constructor param ([#10](https://github.com/proteinjs/db/issues/10)) ([6f963c4](https://github.com/proteinjs/db/commit/6f963c4daaa1f6fcff18cbc5714be6ed9d3b42f7))





## [1.1.17](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.15...@proteinjs/db-ui@1.1.17) (2024-08-16)


### Bug Fixes

* refactored to implement new @proteinjs/logger/Logger api ([66578f2](https://github.com/proteinjs/db/commit/66578f267d9293c0d5703c63e53d8edf68325f52))
* reverted package versions to before failed publishes ([f63518c](https://github.com/proteinjs/db/commit/f63518cf27b74b53571254621dfe9df63aa94871))
* reverted versions of packages that failed to publish so they will be re-published ([e2f83b0](https://github.com/proteinjs/db/commit/e2f83b0c8664ab9ad22d9d641639df6eeab6b63f))


### Reverts

* Revert "chore(release): publish [skip ci]" ([822bec0](https://github.com/proteinjs/db/commit/822bec053324b13522a6f754cf1f3771d8a24f8e))





## [1.1.16](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.15...@proteinjs/db-ui@1.1.16) (2024-08-11)


### Bug Fixes

* reverted package versions to before failed publishes ([f63518c](https://github.com/proteinjs/db/commit/f63518cf27b74b53571254621dfe9df63aa94871))


### Reverts

* Revert "chore(release): publish [skip ci]" ([822bec0](https://github.com/proteinjs/db/commit/822bec053324b13522a6f754cf1f3771d8a24f8e))





## [1.1.16](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.15...@proteinjs/db-ui@1.1.16) (2024-08-10)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.1.14](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.13...@proteinjs/db-ui@1.1.14) (2024-08-07)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.1.11](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.10...@proteinjs/db-ui@1.1.11) (2024-08-05)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.1.9](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.8...@proteinjs/db-ui@1.1.9) (2024-08-02)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.1.8](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.7...@proteinjs/db-ui@1.1.8) (2024-07-29)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.1.5](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.4...@proteinjs/db-ui@1.1.5) (2024-07-11)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.1.3](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.1.2...@proteinjs/db-ui@1.1.3) (2024-07-09)

**Note:** Version bump only for package @proteinjs/db-ui





# [1.1.0](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.33...@proteinjs/db-ui@1.1.0) (2024-07-06)


### Bug Fixes

* updating package version for ui ([f670078](https://github.com/proteinjs/db/commit/f670078a684038c9880dcf9a41a65d4eea540b3a))


### Features

* utilize react query and add infinite scroll to table ([#6](https://github.com/proteinjs/db/issues/6)) ([7244a68](https://github.com/proteinjs/db/commit/7244a68fbce5ca1270321c6c63366ea4f3d97b63))





## [1.0.32](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.31...@proteinjs/db-ui@1.0.32) (2024-06-27)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.0.31](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.30...@proteinjs/db-ui@1.0.31) (2024-06-24)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.0.30](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.29...@proteinjs/db-ui@1.0.30) (2024-06-19)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.0.29](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.28...@proteinjs/db-ui@1.0.29) (2024-06-19)


### Bug Fixes

* handle undefined values when building a condition, querying, inserting, updating, or deleting and allow null in all column types ([#2](https://github.com/proteinjs/db/issues/2)) ([7edda4e](https://github.com/proteinjs/db/commit/7edda4e6e39a4c75fc70122daeb205a79eccc173))





## [1.0.28](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.27...@proteinjs/db-ui@1.0.28) (2024-06-15)


### Bug Fixes

* Allow null values to be passed into Spanner DML ([#1](https://github.com/proteinjs/db/issues/1)) ([db1def2](https://github.com/proteinjs/db/commit/db1def2610298309911e8edc1e1c1497dbf2f7a7))





## [1.0.27](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.26...@proteinjs/db-ui@1.0.27) (2024-06-02)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.0.25](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.24...@proteinjs/db-ui@1.0.25) (2024-05-24)

**Note:** Version bump only for package @proteinjs/db-ui





## [1.0.21](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.20...@proteinjs/db-ui@1.0.21) (2024-05-17)


### Bug Fixes

* update settings table to be a scoped table ([db57b82](https://github.com/proteinjs/db/commit/db57b82dafe32b1111592837696216c9bb45b4fc))





## [1.0.18](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.17...@proteinjs/db-ui@1.0.18) (2024-05-10)


### Bug Fixes

* add .md file type to lint ignore files ([9460a31](https://github.com/proteinjs/db/commit/9460a313cd418250115922f687277f1b01dce238))





## [1.0.17](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.16...@proteinjs/db-ui@1.0.17) (2024-05-10)


### Bug Fixes

* add linting and lint all files ([f9859a3](https://github.com/proteinjs/db/commit/f9859a39882376fe7b93aa3b4281b22b2c02b7d5))
* lint db-ui package ([b8e6a95](https://github.com/proteinjs/db/commit/b8e6a956eb2d6a75f7c9073902a8f25cb8abe93b))





## [1.0.16](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.15...@proteinjs/db-ui@1.0.16) (2024-05-09)

**Note:** Version bump only for package @proteinjs/db-ui

## [1.0.14](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.13...@proteinjs/db-ui@1.0.14) (2024-05-03)

**Note:** Version bump only for package @proteinjs/db-ui

## [1.0.13](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.12...@proteinjs/db-ui@1.0.13) (2024-05-02)

**Note:** Version bump only for package @proteinjs/db-ui

## [1.0.12](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.11...@proteinjs/db-ui@1.0.12) (2024-04-30)

### Bug Fixes

- updated `UuidGeneratorPage` to use standard id formatting ([4ebce0a](https://github.com/proteinjs/db/commit/4ebce0a7e92fa4d05ddf552b5d41e47f96019808))

## [1.0.8](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.7...@proteinjs/db-ui@1.0.8) (2024-04-26)

### Bug Fixes

- remove `instanceof` calls in .tsx files; add ui hiding config to corresponding columns ([19c818e](https://github.com/proteinjs/db/commit/19c818eed74197834474231042f51da0a9fe21ed))

## [1.0.7](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.6...@proteinjs/db-ui@1.0.7) (2024-04-26)

### Bug Fixes

- `SchemaMetadata.tableExists` include condition to query `TABLE_SCHEMA` by default for mysql ([b4e6d22](https://github.com/proteinjs/db/commit/b4e6d224d93db75c83ad75160b83346f2b12d166))

## [1.0.3](https://github.com/proteinjs/db/compare/@proteinjs/db-ui@1.0.2...@proteinjs/db-ui@1.0.3) (2024-04-19)

**Note:** Version bump only for package @proteinjs/db-ui

## [1.0.2](https://github.com/brentbahry/db/compare/@proteinjs/db-ui@1.0.1...@proteinjs/db-ui@1.0.2) (2024-04-19)

**Note:** Version bump only for package @proteinjs/db-ui

## 1.0.1 (2024-04-19)

**Note:** Version bump only for package @proteinjs/db-ui
