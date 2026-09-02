# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.29.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.29.1...@proteinjs/db-driver-spanner@1.29.2) (2026-09-02)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.29.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.29.0...@proteinjs/db-driver-spanner@1.29.1) (2026-09-02)


### Bug Fixes

* **db-driver-spanner): honest session-pool gauge + pool-less provisioner handles. poolStats reused the vendor pool's 'borrowed' getter, which folds IN-FLIGHT CREATIONS (_pending) into borrowed — a freshly-constructed pool mid-fill read as 'borrowed 25 / available 0', and logPoolPressure's waiters>0 trigger fired on every pool construction's fill window: 136-156 false 'session pool under pressure' warnings per thought CI sweep, which sent the 2026-09-02 diagnosis down a session-leak hunt (instrumented sweeps show borrowed returning to 0 at every suite end; the reds were emulator-process degradation, fixed repo-side). borrowed now excludes pending (reported separately as the fifth gauge number) and the warning fires only when waiters EXCEED in-flight creations — a pool at max or with failing creations still warns. SpannerEmulatorProvisioner handles go pool-less (min 0, the SpannerDriver.createDb pattern:** the createDatabase handle's default pool close() raced its own 25-session constructor batch fill and orphaned 25 emulator sessions per provisioning pass (the emulator never reaps them). The retention pin rides the create handle before its close, and the already-exists path constructs its handle DIRECTLY — Database.close() evicts the instance handle cache under the bare name key only, so re-asking instance.database(name, sameOptions) returned the CLOSED cached handle ('Database is closed.', caught red by the re-ensure test). Red-first: 3 new/updated gauge tests fail pre-fix (fill window warns; no pending field). Bite: pressure guard reverted to waiters>0 -> fill-window test red; restored -> green. Tallies: SpannerLivenessMonitor 12/12 (3 new), full driver suite on a fresh dedicated emulator 32/32 suites / 214/214 tests, 0 sessions left after a consumer (thought-server) slice. ([5e1d8c8](https://github.com/proteinjs/db/commit/5e1d8c8cae2a3b5325c8ff17603b898fac49b5d6))





# [1.29.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.28.0...@proteinjs/db-driver-spanner@1.29.0) (2026-09-02)


### Bug Fixes

* FLOAT64 params bind from the column type — integral values (0, 7) no longer rejected with "Could not parse 0 as a FLOAT64" ([76a746e](https://github.com/proteinjs/db/commit/76a746ece27c87ebfab678473da4d75c714db8e8))
* r5asm2 composition repairs — the env-token auth wiring rides the composed SpannerDriver (my re-merge resolution had taken main's side of the conflicted construction sites; EnvTokenAuth suite caught it red — envTokenAuthOverride at both constructions, withDeadline + DDL translateAuthFailure, recycleClient clears the selection; suite red->green 212/212); db jest singleton pins (reflection + user-auth — the §6.15 second-copy class, ServiceAuth's UserAuth must be the suites', CI-inert) ([76fea0d](https://github.com/proteinjs/db/commit/76fea0ddaca69856aa55fea61b3a4deae020053f))


### Features

* grouped-aggregation reads — Db.queryAggregates + QueryBuilder.timeBucket ([1d553a4](https://github.com/proteinjs/db/commit/1d553a45d93040b560c9f08b4376b875250877c9))
* SpannerDriver env-token auth — the client builds on an env-delivered bearer token when CLOUDSDK_AUTH_ACCESS_TOKEN is present ([06b01c1](https://github.com/proteinjs/db/commit/06b01c16dad4c981b2006770b21366cd7165c379))
* timeBucket hour grain — widen the unit union to day|hour across query + drivers ([3ccd736](https://github.com/proteinjs/db/commit/3ccd736138c646454015d46274a2491edcfd90dd))





# [1.28.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.27.1...@proteinjs/db-driver-spanner@1.28.0) (2026-09-02)


### Features

* **db:** DetachedDbOps — THE named detachment idiom for deliberately fire-and-forget db work (one owner). Under node's default unhandled-rejection policy (node 24 in production) a detached db operation that rejects — e.g. a write tripping the driver's 60s op deadline — killed the whole process (observed live: a detached write past the deadline aborted the server). DetachedDbOps.run(description, work, context?) invokes the work, terminally catches (synchronous throws included), and logs the failure WITH the caller's context — never process death, never a silent swallow; returns void by design so a detached outcome cannot be accidentally consumed. Exported from the package root for every consumer's deliberate detached DML. The repo's own deliberate detached call sites route through it: SpannerLivenessMonitor's two detached verifyLiveness dispatches (pool-error listener + driver-reported error); the client-recycle oldDb.close stays on its existing terminal catch (its silent swallow is a named decision — the channel is believed dead). No half-existing db-layer idiom found to extend: the service layer's doNotAwait observer (ServiceExecutor) covers only service-dispatched work. RED RUN stated: DetachedDbOps.test red at the absent module (the simulated 60s-deadline driver rejection is the suite's first pin); green wired 4/4. Bites verified: terminal catch dropped -> the 2 rejection pins red; sync containment dropped -> the sync-throw pin red alone; restored green. Suites: packages/db 16 suites / 134 tests green (130 pre-existing + 4 new); drivers/spanner Liveness 1/1 green on a dedicated emulator (:9040) — the routed pool-error path exercised live; driver tsc clean (the one build red was the cloned stale db-query dist, cleared by rebuilding query from main source). ([3b92847](https://github.com/proteinjs/db/commit/3b92847355b23db7013fb9bf11fd1b6e7e879b72))





## [1.27.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.27.0...@proteinjs/db-driver-spanner@1.27.1) (2026-09-01)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.27.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.26.1...@proteinjs/db-driver-spanner@1.27.0) (2026-08-31)


### Features

* timeBucket minute grain — widen the unit union to day|hour|minute across query + drivers (USAGE_ATTRIBUTION §5) ([fe25c4b](https://github.com/proteinjs/db/commit/fe25c4b9fbeae3be1ec18f9ff4e1fac4998a9e5e))





## [1.26.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.26.0...@proteinjs/db-driver-spanner@1.26.1) (2026-08-29)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.26.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.25.0...@proteinjs/db-driver-spanner@1.26.0) (2026-08-29)


### Features

* grouped-aggregation reads — Db.queryAggregates + QueryBuilder.timeBucket ([f94e564](https://github.com/proteinjs/db/commit/f94e564e6312f4c224d500e3d5fb0d53e3d9b59f))
* timeBucket hour grain — widen the unit union to day|hour across query + drivers ([153e3d0](https://github.com/proteinjs/db/commit/153e3d09c6c56d7746f9071e1f57ac527b07dc55))





# [1.25.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.24.0...@proteinjs/db-driver-spanner@1.25.0) (2026-08-29)


### Features

* ReferenceColumn width adoption — optional maxLength (the documented DynamicReferenceColumn affordance, mirrored) so an existing string-uuid column retypes to a reference IN PLACE: such columns predate the reference type at StringColumn's 255 default, the stock 36 is a narrowing Spanner refuses (the sync would throw at boot), and a reference stores the same id bytes — adopting the width makes the retype invisible to the schema sync (zero DDL); emulator suite pins the zero-changes sync, byte-identity in both directions over a string-era row, and the refused narrowing ([03ae826](https://github.com/proteinjs/db/commit/03ae8267a2eaba2a252e36c53f785b708c68b4ee))





# [1.24.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.23.5...@proteinjs/db-driver-spanner@1.24.0) (2026-08-28)


### Bug Fixes

* unique-constraint index creation resolved the unique column by NAME through the property-keyed table.columns map — crashes at create-table time for any unique column whose property name differs from its column name (e.g. jobTitle -> job_title); the column object in hand IS the unique column, so index it directly ([81967c6](https://github.com/proteinjs/db/commit/81967c6c0522affe14ebbab9bcdbe0b80e786dfa))


### Features

* column encryption as a first-class db-layer feature ([d57339d](https://github.com/proteinjs/db/commit/d57339d97bb00109b7db68ec76caad7be592d6e3))





## [1.23.5](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.23.4...@proteinjs/db-driver-spanner@1.23.5) (2026-08-27)


### Bug Fixes

* FLOAT64 params bind from the column type — integral values (0, 7) no longer rejected with "Could not parse 0 as a FLOAT64" ([73026ee](https://github.com/proteinjs/db/commit/73026eeb3a5348ed9245032ab0767cefde883f11))





## [1.23.4](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.23.3...@proteinjs/db-driver-spanner@1.23.4) (2026-08-26)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.23.3](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.23.2...@proteinjs/db-driver-spanner@1.23.3) (2026-08-26)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.23.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.23.1...@proteinjs/db-driver-spanner@1.23.2) (2026-08-24)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.23.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.23.0...@proteinjs/db-driver-spanner@1.23.1) (2026-08-23)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.23.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.22.1...@proteinjs/db-driver-spanner@1.23.0) (2026-08-19)


### Features

* export SpannerSchemaOperations from the spanner-driver root — consumer test harnesses provision cirun databases schema-first (task [#41](https://github.com/proteinjs/db/issues/41) adoption gate) ([3242ae4](https://github.com/proteinjs/db/commit/3242ae41d9f87bb5d788000b8e75ffbfead8fd0e))





## [1.22.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.22.0...@proteinjs/db-driver-spanner@1.22.1) (2026-08-19)


### Bug Fixes

* migration run-state writes omit absent optional fields — a void run() or non-Error throw can never wedge a row at 'running' ([350dbb9](https://github.com/proteinjs/db/commit/350dbb9590c2ac697807b6e1f11cf29ef90c1cdb)), closes [#124](https://github.com/proteinjs/db/issues/124) [#57](https://github.com/proteinjs/db/issues/57)
* spanner-driver rebuilds stop self-eating — dist excluded from tsc inputs ([35b3046](https://github.com/proteinjs/db/commit/35b304613f5b419027370cf53315aea26197aeef))





# [1.22.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.21.0...@proteinjs/db-driver-spanner@1.22.0) (2026-08-18)


### Features

* source-record sync — onSourceRemoved policies, natural-key adoption, unique-index duplicate preflight ([1345bfc](https://github.com/proteinjs/db/commit/1345bfcd2bd3f457dddacb5770bf723828d98fa9))





# [1.21.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.20.3...@proteinjs/db-driver-spanner@1.21.0) (2026-08-17)


### Bug Fixes

* **db-driver-spanner:** root test.js/test.d.ts shims for the ./test subpath — paths-mapped consumers resolve built dist, not sources ([d51556f](https://github.com/proteinjs/db/commit/d51556f07affcdbd80d80d19ed41d1257cc9a0cc))


### Features

* **db:** retired-migration flag — the deploy series stamps source-less ledger rows and never auto-runs retired rows ([f468125](https://github.com/proteinjs/db/commit/f4681257439e2e7e031f9d7f4d90b7463cc46456))





## [1.20.3](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.20.2...@proteinjs/db-driver-spanner@1.20.3) (2026-08-15)


### Bug Fixes

* reconcile re-read rides out brief INFORMATION_SCHEMA propagation (bounded retry) ([0f4739b](https://github.com/proteinjs/db/commit/0f4739bb2f233d9dff462cf7ec74777f53ea0de6))





## [1.20.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.20.1...@proteinjs/db-driver-spanner@1.20.2) (2026-08-15)


### Bug Fixes

* schema reconcile logs the concurrent-ALREADY_EXISTS tolerance loudly (WARN) ([8e95c92](https://github.com/proteinjs/db/commit/8e95c92c3757bd577048a269e28a072a2e045208))





## [1.20.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.20.0...@proteinjs/db-driver-spanner@1.20.1) (2026-08-15)


### Bug Fixes

* schema reconcile tolerates concurrent ALREADY_EXISTS — verify-then-succeed, closes the multi-actor boot race ([ef6afa5](https://github.com/proteinjs/db/commit/ef6afa55690f6481435bc4356cf6cc301869e08f))





# [1.20.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.19.0...@proteinjs/db-driver-spanner@1.20.0) (2026-08-14)


### Bug Fixes

* schema-update failure log dropped apply-phase reasons; adversarial P0 verification hardening ([c39ecd8](https://github.com/proteinjs/db/commit/c39ecd8435c6e102cb6ef34cbd9d5cea22580e2b))


### Features

* batched DDL — a table set's schema rides one schema-update operation ([f9e302b](https://github.com/proteinjs/db/commit/f9e302bf088d071c03682ac5f33f5d365aa3a5a4))
* database lifecycle primitives — createDb(name, { ddl }) and dropDb(name) on DbDriver ([7cdb538](https://github.com/proteinjs/db/commit/7cdb538bcb7824682f92dcdf5a131f39e097df8f))





# [1.19.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.18.0...@proteinjs/db-driver-spanner@1.19.0) (2026-08-14)


### Bug Fixes

* DML off the streaming transport — silent client replays re-executed lost-response statements ([#33](https://github.com/proteinjs/db/issues/33)) ([06dc699](https://github.com/proteinjs/db/commit/06dc69980d738f1a2a90233c585df2bb2f3b8e32))


### Features

* cursor-window paging owner; RecordIterator migrated off offset paging ([453c4a2](https://github.com/proteinjs/db/commit/453c4a2a5f87bd7b58b0042185100bcf9ae0e183))
* deploy-gated migration series — manual flag + runPendingMigrations (27f) ([1d3acc4](https://github.com/proteinjs/db/commit/1d3acc43a9de4e12d7a231b292883bd0d523a11c))





# [1.18.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.17.0...@proteinjs/db-driver-spanner@1.18.0) (2026-08-14)


### Features

* **spanner:** public SpannerDriver.getSessionPoolStats() — the P4a pool gauge for external observers (the ops monitors platform) ([00d1b9f](https://github.com/proteinjs/db/commit/00d1b9f0b36f5436ed0e25ef2f8bcf430f5551c3))





# [1.17.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.16.3...@proteinjs/db-driver-spanner@1.17.0) (2026-08-14)


### Bug Fixes

* **test:** abort-aware DDL-rejection control in the provisioner re-ensure suite ([8418cb2](https://github.com/proteinjs/db/commit/8418cb20609d279b35e654948540d690a79b6923))
* **test:** provisioner control detects emulator DDL-rejection semantics ([3da031a](https://github.com/proteinjs/db/commit/3da031a4a74f172b1dc7df73d273be028c900508))


### Features

* ensureMigrationRun — system-context boot API for deploy-coupled migrations ([d771c7b](https://github.com/proteinjs/db/commit/d771c7bc8958ebd38e15b1fd86fde19267ec3d9f))





## [1.16.3](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.16.2...@proteinjs/db-driver-spanner@1.16.3) (2026-08-14)


### Bug Fixes

* condition binds normalize Moment values at the parameterize boundary — the home-recents TIMESTAMP 400 ([812d74e](https://github.com/proteinjs/db/commit/812d74e3ddf69e77fa4cf343dc7e8064ebcfc263))





## [1.16.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.16.1...@proteinjs/db-driver-spanner@1.16.2) (2026-08-13)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.16.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.16.0...@proteinjs/db-driver-spanner@1.16.1) (2026-08-13)


### Performance Improvements

* preloadReferences batches loads — one IN query per referenced table ([1cf56b0](https://github.com/proteinjs/db/commit/1cf56b043c6c8078243bb829ab2d89b580476767))





# [1.16.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.15.0...@proteinjs/db-driver-spanner@1.16.0) (2026-08-13)


### Bug Fixes

* **spanner-test:** provisioner re-ensure is zero-DDL — reconcile the retention pin instead of blind ALTER ([312427d](https://github.com/proteinjs/db/commit/312427de54856eb3d7508afa699f141f3edc1c1e))


### Features

* composite unique indexes — Table.indexes gains unique, threaded through schema ops ([dabefd0](https://github.com/proteinjs/db/commit/dabefd07c4fc797c3d06c8c0770b7674ad33d018))





# [1.15.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.14.4...@proteinjs/db-driver-spanner@1.15.0) (2026-08-12)


### Features

* **spanner-test:** pin emulator database version_retention_period to 1m in provisioner ([20dc37d](https://github.com/proteinjs/db/commit/20dc37db64bfd73e7e1b531136bda815844f90bb))





## [1.14.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.14.1...@proteinjs/db-driver-spanner@1.14.2) (2026-08-09)


### Bug Fixes

* close the orphan Database handle createDatabase constructs (unlistened pool crashes suites) ([7dca699](https://github.com/proteinjs/db/commit/7dca6999f34c80958a2244780a8679ed8c2e312a))





## [1.14.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.14.0...@proteinjs/db-driver-spanner@1.14.1) (2026-08-09)


### Bug Fixes

* own the Database error channel — unlistened session-pool 'error' events crash the process ([67ecece](https://github.com/proteinjs/db/commit/67ececebdb3550c65b63f389801d3a4c42e11b6b))





# [1.14.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.13.0...@proteinjs/db-driver-spanner@1.14.0) (2026-08-08)


### Features

* spanner op deadlines + channel-death recycle (2026-08-06 overnight wedge) ([ea5fa98](https://github.com/proteinjs/db/commit/ea5fa987bf68f9c10a58aa6bd1e14e792c3aff03))
* stateless transactions — ambient resolution at call time + ended-context tombstone ([b073491](https://github.com/proteinjs/db/commit/b0734917ff9d3643b09c3d1498b694ff626f55ca))
* transaction-safety guard, rollback-on-error, session pool options + pressure gauge (P2/P4a) ([c9dcaf0](https://github.com/proteinjs/db/commit/c9dcaf05169eec2d4e96e7558dfc39b71d92202f))





## [1.12.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.12.0...@proteinjs/db-driver-spanner@1.12.1) (2026-07-28)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.12.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.11.1...@proteinjs/db-driver-spanner@1.12.0) (2026-07-24)


### Features

* **db,spanner:** in-place STRING column widening ([b72f8f7](https://github.com/proteinjs/db/commit/b72f8f765b2ee56380ca67ab911f21fb8a512452))





## [1.11.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.11.0...@proteinjs/db-driver-spanner@1.11.1) (2026-07-24)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.11.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.21...@proteinjs/db-driver-spanner@1.11.0) (2026-07-23)


### Features

* **spanner:** SpannerEmulatorProvisioner — shared test-harness emulator provisioning ([b9e634a](https://github.com/proteinjs/db/commit/b9e634ab74580a66e589ce277985aca21e13a518))





## [1.10.20](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.19...@proteinjs/db-driver-spanner@1.10.20) (2026-07-21)


### Bug Fixes

* gRPC channel keepalive on the Spanner client ([b72d18b](https://github.com/proteinjs/db/commit/b72d18b7bd0fcbb9954de16f297e95013dc0ffe0))
* **spanner:** keepalive pings only during active calls — idle pings broke CI emulator ([ed9651d](https://github.com/proteinjs/db/commit/ed9651d2dd65934dbf8dad26355dc6f4b4919e9c))





## [1.10.19](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.18...@proteinjs/db-driver-spanner@1.10.19) (2026-07-10)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.10.18](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.17...@proteinjs/db-driver-spanner@1.10.18) (2026-07-09)


### Bug Fixes

* survive Spanner session-pool errors with a liveness policy instead of crashing ([6165726](https://github.com/proteinjs/db/commit/6165726d618b820fb2ffcec0860c1ca558ee94ee))





## [1.10.17](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.16...@proteinjs/db-driver-spanner@1.10.17) (2026-06-08)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.10.15](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.14...@proteinjs/db-driver-spanner@1.10.15) (2026-04-18)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.10.11](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.10...@proteinjs/db-driver-spanner@1.10.11) (2026-04-08)


### Bug Fixes

* add --passWithNoTests to jest test scripts ([5d09cb3](https://github.com/proteinjs/db/commit/5d09cb3857546d5955307c651a177df86d167da6))





## [1.10.10](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.9...@proteinjs/db-driver-spanner@1.10.10) (2026-04-07)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.10.8](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.7...@proteinjs/db-driver-spanner@1.10.8) (2026-03-07)


### Bug Fixes

* Update `KnexColumnTypeFactory` and `SpannerColumnTypeFactory` to accommodate `isInstanceOf` becoming a type guard. ([833fb14](https://github.com/proteinjs/db/commit/833fb1474297b358a3a6bc52105ed86353314ad3))





## [1.10.7](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.6...@proteinjs/db-driver-spanner@1.10.7) (2026-03-06)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.10.5](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.4...@proteinjs/db-driver-spanner@1.10.5) (2026-02-12)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.10.4](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.3...@proteinjs/db-driver-spanner@1.10.4) (2025-11-22)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.10.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.10.0...@proteinjs/db-driver-spanner@1.10.1) (2025-11-13)


### Bug Fixes

* Any package (in this case, the drivers) that exports test utilities needs to import local source through the package (ie. `import { SpannerDriver' } from '@proteinjs/db-driver-spanner'`) in those utilities. Relative path imports to the src will result in type mismatches in the consuming package's test files. ([e92f361](https://github.com/proteinjs/db/commit/e92f361369d6cfee2657384ad543e1317caa124c))





# [1.10.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-spanner@1.9.0...@proteinjs/db-driver-spanner@1.10.0) (2025-11-13)


### Bug Fixes

* Re-work db and drivers to separate test utils into a separate build (ie. @proteinjs/db/test). ([70c85e0](https://github.com/proteinjs/db/commit/70c85e0c1e3399e001d37be01adfd9ac13abd109))


### Features

* Expose `DB_LOG_LEVEL` so tests can ignore noisy logs like table creation. ([4799938](https://github.com/proteinjs/db/commit/4799938827c4c426655ff3936cbe72a1b9c2de4d))





# [1.9.0](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.8.15...@proteinjs/db-driver-spanner@1.9.0) (2025-11-08)


### Features

* Reverse cascade delete ([#20](https://github.com/brentbahry/db/issues/20)) ([8aa734f](https://github.com/brentbahry/db/commit/8aa734f7c5cb2398ebced01f31cc62898d22aae0))





## [1.8.14](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.8.13...@proteinjs/db-driver-spanner@1.8.14) (2025-09-28)


### Bug Fixes

* always use column name when creating indexes ([#18](https://github.com/brentbahry/db/issues/18)) ([6e80a8f](https://github.com/brentbahry/db/commit/6e80a8fe37ac3b92d7a9b6b60fa9239f5c504646))





## [1.8.13](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.8.12...@proteinjs/db-driver-spanner@1.8.13) (2025-09-24)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.8.11](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.8.10...@proteinjs/db-driver-spanner@1.8.11) (2025-09-09)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.8.10](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.8.9...@proteinjs/db-driver-spanner@1.8.10) (2025-08-20)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.8.6](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.8.5...@proteinjs/db-driver-spanner@1.8.6) (2025-04-24)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.8.4](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.8.3...@proteinjs/db-driver-spanner@1.8.4) (2025-04-15)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.8.2](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.8.1...@proteinjs/db-driver-spanner@1.8.2) (2025-04-02)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.8.1](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.8.0...@proteinjs/db-driver-spanner@1.8.1) (2025-03-28)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.8.0](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.7.0...@proteinjs/db-driver-spanner@1.8.0) (2025-02-07)


### Features

* Dynamic reference column ([#12](https://github.com/brentbahry/db/issues/12)) ([554b2e4](https://github.com/brentbahry/db/commit/554b2e4159f1d692d2ae976461c60f88639ecf22))





# [1.7.0](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.6.3...@proteinjs/db-driver-spanner@1.7.0) (2024-12-11)


### Bug Fixes

* add transactionContextFactory to tests to bypass reflection error ([d8021f4](https://github.com/brentbahry/db/commit/d8021f4b5ed19f9bc536af8e62703d7ff51f635a))


### Features

* implement usage of new transaction context package in db and add it as dependency in db driver packages ([a1bc03a](https://github.com/brentbahry/db/commit/a1bc03ae7cde59237ab24a7cbb3e168b4425df9d))





## [1.6.3](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.6.2...@proteinjs/db-driver-spanner@1.6.3) (2024-12-10)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.6.2](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.6.1...@proteinjs/db-driver-spanner@1.6.2) (2024-11-07)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.6.1](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.6.0...@proteinjs/db-driver-spanner@1.6.1) (2024-11-06)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.6.0](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.5.1...@proteinjs/db-driver-spanner@1.6.0) (2024-10-31)


### Features

* transaction support version bump ([5908646](https://github.com/brentbahry/db/commit/59086469a2a9bb551fd86425f43f9900f6f9a3fc))





## [1.5.1](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.5.0...@proteinjs/db-driver-spanner@1.5.1) (2024-10-21)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.5.0](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.4.15...@proteinjs/db-driver-spanner@1.5.0) (2024-10-05)


### Features

* add support for `JsonColumn` ([f60db36](https://github.com/brentbahry/db/commit/f60db36159ae75de044a81d58d3d5156aa02c620))





## [1.4.15](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.4.14...@proteinjs/db-driver-spanner@1.4.15) (2024-09-27)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.4.8](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.4.7...@proteinjs/db-driver-spanner@1.4.8) (2024-08-16)


### Bug Fixes

* refactored to implement new @proteinjs/logger/Logger api ([66578f2](https://github.com/brentbahry/db/commit/66578f267d9293c0d5703c63e53d8edf68325f52))





## [1.4.7](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.4.6...@proteinjs/db-driver-spanner@1.4.7) (2024-08-11)


### Bug Fixes

* reverted package versions to before failed publishes ([f63518c](https://github.com/brentbahry/db/commit/f63518cf27b74b53571254621dfe9df63aa94871))


### Reverts

* Revert "chore(release): publish [skip ci]" ([822bec0](https://github.com/brentbahry/db/commit/822bec053324b13522a6f754cf1f3771d8a24f8e))





## [1.4.7](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.4.6...@proteinjs/db-driver-spanner@1.4.7) (2024-08-10)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.4.6](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.4.5...@proteinjs/db-driver-spanner@1.4.6) (2024-08-07)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.4.3](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.4.2...@proteinjs/db-driver-spanner@1.4.3) (2024-08-05)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.4.1](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.4.0...@proteinjs/db-driver-spanner@1.4.1) (2024-08-02)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.4.0](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.3.5...@proteinjs/db-driver-spanner@1.4.0) (2024-07-29)


### Features

* remove createProxy in ReferenceArray and add additional helper functions ([#9](https://github.com/brentbahry/db/issues/9)) ([bf00e2e](https://github.com/brentbahry/db/commit/bf00e2eeedd5f6d96bc64461bd3c4136a2b3a015))





## [1.3.3](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.3.2...@proteinjs/db-driver-spanner@1.3.3) (2024-07-11)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.3.2](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.3.1...@proteinjs/db-driver-spanner@1.3.2) (2024-07-09)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





# [1.3.0](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.2.1...@proteinjs/db-driver-spanner@1.3.0) (2024-07-06)


### Features

* utilize react query and add infinite scroll to table ([#6](https://github.com/brentbahry/db/issues/6)) ([7244a68](https://github.com/brentbahry/db/commit/7244a68fbce5ca1270321c6c63366ea4f3d97b63))





# [1.2.0](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.16...@proteinjs/db-driver-spanner@1.2.0) (2024-06-27)


### Bug Fixes

* updating packages for db changes ([2328d68](https://github.com/brentbahry/db/commit/2328d68865e3315f73ecf4c98c227127bedc699c))


### Features

* add case sensitivity control to condition ([#4](https://github.com/brentbahry/db/issues/4)) ([13da747](https://github.com/brentbahry/db/commit/13da7477be6216d4449311ad3a68ef3cde246d45))





## [1.1.16](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.15...@proteinjs/db-driver-spanner@1.1.16) (2024-06-24)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.1.15](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.14...@proteinjs/db-driver-spanner@1.1.15) (2024-06-19)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.1.14](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.13...@proteinjs/db-driver-spanner@1.1.14) (2024-06-19)


### Bug Fixes

* handle undefined values when building a condition, querying, inserting, updating, or deleting and allow null in all column types ([#2](https://github.com/brentbahry/db/issues/2)) ([7edda4e](https://github.com/brentbahry/db/commit/7edda4e6e39a4c75fc70122daeb205a79eccc173))





## [1.1.13](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.12...@proteinjs/db-driver-spanner@1.1.13) (2024-06-15)


### Bug Fixes

* Allow null values to be passed into Spanner DML ([#1](https://github.com/brentbahry/db/issues/1)) ([db1def2](https://github.com/brentbahry/db/commit/db1def2610298309911e8edc1e1c1497dbf2f7a7))





## [1.1.12](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.11...@proteinjs/db-driver-spanner@1.1.12) (2024-06-02)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.1.10](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.9...@proteinjs/db-driver-spanner@1.1.10) (2024-05-24)

**Note:** Version bump only for package @proteinjs/db-driver-spanner





## [1.1.7](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.6...@proteinjs/db-driver-spanner@1.1.7) (2024-05-17)


### Bug Fixes

* update settings table to be a scoped table ([db57b82](https://github.com/brentbahry/db/commit/db57b82dafe32b1111592837696216c9bb45b4fc))





## [1.1.4](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.3...@proteinjs/db-driver-spanner@1.1.4) (2024-05-10)


### Bug Fixes

* add .md file type to lint ignore files ([9460a31](https://github.com/brentbahry/db/commit/9460a313cd418250115922f687277f1b01dce238))





## [1.1.3](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.2...@proteinjs/db-driver-spanner@1.1.3) (2024-05-10)


### Bug Fixes

* add linting and lint all files ([f9859a3](https://github.com/brentbahry/db/commit/f9859a39882376fe7b93aa3b4281b22b2c02b7d5))





## [1.1.2](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.1.1...@proteinjs/db-driver-spanner@1.1.2) (2024-05-09)

### Bug Fixes

- `SpannerColumnTypeFactory` a `DateColumn` should also be a `TIMESTAMP` in spanner ([29e8b36](https://github.com/brentbahry/db/commit/29e8b36edf2911e0188180d73fa11116482f42ac))

# [1.1.0](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.0.11...@proteinjs/db-driver-spanner@1.1.0) (2024-05-03)

### Features

- updated `SpannerConfig` to include `SpannerOptions` ([53d9aae](https://github.com/brentbahry/db/commit/53d9aaeb401b7a1272e3b66df448352de2281226))

## [1.0.11](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.0.10...@proteinjs/db-driver-spanner@1.0.11) (2024-05-02)

### Bug Fixes

- db now requires a `DefaultDbDriverFactory` implementation to get default driver ([29daebd](https://github.com/brentbahry/db/commit/29daebdd971b106142eb525380f5a7d12a3d8eb6))

## [1.0.8](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.0.7...@proteinjs/db-driver-spanner@1.0.8) (2024-04-26)

**Note:** Version bump only for package @proteinjs/db-driver-spanner

## [1.0.7](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.0.6...@proteinjs/db-driver-spanner@1.0.7) (2024-04-26)

### Bug Fixes

- `SchemaMetadata.tableExists` include condition to query `TABLE_SCHEMA` by default for mysql ([b4e6d22](https://github.com/brentbahry/db/commit/b4e6d224d93db75c83ad75160b83346f2b12d166))

## [1.0.2](https://github.com/brentbahry/db/compare/@proteinjs/db-driver-spanner@1.0.1...@proteinjs/db-driver-spanner@1.0.2) (2024-04-19)

**Note:** Version bump only for package @proteinjs/db-driver-spanner

## 1.0.1 (2024-04-19)

**Note:** Version bump only for package @proteinjs/db-driver-spanner
