# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.12.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.12.0...@proteinjs/db-driver-knex@1.12.1) (2026-08-29)

**Note:** Version bump only for package @proteinjs/db-driver-knex





# [1.12.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.13...@proteinjs/db-driver-knex@1.12.0) (2026-08-29)


### Features

* grouped-aggregation reads — Db.queryAggregates + QueryBuilder.timeBucket ([f94e564](https://github.com/proteinjs/db/commit/f94e564e6312f4c224d500e3d5fb0d53e3d9b59f))
* timeBucket hour grain — widen the unit union to day|hour across query + drivers ([153e3d0](https://github.com/proteinjs/db/commit/153e3d09c6c56d7746f9071e1f57ac527b07dc55))





## [1.11.13](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.12...@proteinjs/db-driver-knex@1.11.13) (2026-08-29)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.12](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.11...@proteinjs/db-driver-knex@1.11.12) (2026-08-28)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.11](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.10...@proteinjs/db-driver-knex@1.11.11) (2026-08-26)


### Bug Fixes

* exclude dist from tsc inputs in db + knex tsconfigs — the test-subpath exclude list (08d47040) replaced TS defaults and lost the automatic outDir exclusion, so any rebuild with an existing dist hit TS5055 (dist d.ts treated as input); spanner driver already carried the corrected pattern ([c8b08ba](https://github.com/proteinjs/db/commit/c8b08baea981ba2dd4bfbe1ba408a69625c6f31d))





## [1.11.10](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.9...@proteinjs/db-driver-knex@1.11.10) (2026-08-26)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.9](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.8...@proteinjs/db-driver-knex@1.11.9) (2026-08-24)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.8](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.7...@proteinjs/db-driver-knex@1.11.8) (2026-08-23)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.7](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.6...@proteinjs/db-driver-knex@1.11.7) (2026-08-19)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.6](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.5...@proteinjs/db-driver-knex@1.11.6) (2026-08-19)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.5](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.4...@proteinjs/db-driver-knex@1.11.5) (2026-08-18)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.4](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.3...@proteinjs/db-driver-knex@1.11.4) (2026-08-17)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.3](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.2...@proteinjs/db-driver-knex@1.11.3) (2026-08-15)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.1...@proteinjs/db-driver-knex@1.11.2) (2026-08-15)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.11.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.11.0...@proteinjs/db-driver-knex@1.11.1) (2026-08-15)

**Note:** Version bump only for package @proteinjs/db-driver-knex





# [1.11.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.10.0...@proteinjs/db-driver-knex@1.11.0) (2026-08-14)


### Features

* batched DDL — a table set's schema rides one schema-update operation ([f9e302b](https://github.com/proteinjs/db/commit/f9e302bf088d071c03682ac5f33f5d365aa3a5a4))
* database lifecycle primitives — createDb(name, { ddl }) and dropDb(name) on DbDriver ([7cdb538](https://github.com/proteinjs/db/commit/7cdb538bcb7824682f92dcdf5a131f39e097df8f))





# [1.10.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.9.4...@proteinjs/db-driver-knex@1.10.0) (2026-08-14)


### Features

* cursor-window paging owner; RecordIterator migrated off offset paging ([453c4a2](https://github.com/proteinjs/db/commit/453c4a2a5f87bd7b58b0042185100bcf9ae0e183))





## [1.9.4](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.9.3...@proteinjs/db-driver-knex@1.9.4) (2026-08-14)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.9.3](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.9.2...@proteinjs/db-driver-knex@1.9.3) (2026-08-14)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.9.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.9.1...@proteinjs/db-driver-knex@1.9.2) (2026-08-13)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.9.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.9.0...@proteinjs/db-driver-knex@1.9.1) (2026-08-13)


### Performance Improvements

* preloadReferences batches loads — one IN query per referenced table ([1cf56b0](https://github.com/proteinjs/db/commit/1cf56b043c6c8078243bb829ab2d89b580476767))





# [1.9.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.8.1...@proteinjs/db-driver-knex@1.9.0) (2026-08-13)


### Features

* composite unique indexes — Table.indexes gains unique, threaded through schema ops ([dabefd0](https://github.com/proteinjs/db/commit/dabefd07c4fc797c3d06c8c0770b7674ad33d018))





## [1.7.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.7.0...@proteinjs/db-driver-knex@1.7.1) (2026-08-08)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.22](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.21...@proteinjs/db-driver-knex@1.6.22) (2026-07-28)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.21](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.20...@proteinjs/db-driver-knex@1.6.21) (2026-07-24)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.20](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.19...@proteinjs/db-driver-knex@1.6.20) (2026-07-24)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.18](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.17...@proteinjs/db-driver-knex@1.6.18) (2026-07-21)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.17](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.16...@proteinjs/db-driver-knex@1.6.17) (2026-07-10)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.15](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.14...@proteinjs/db-driver-knex@1.6.15) (2026-04-18)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.11](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.10...@proteinjs/db-driver-knex@1.6.11) (2026-04-08)


### Bug Fixes

* add --passWithNoTests to jest test scripts ([5d09cb3](https://github.com/proteinjs/db/commit/5d09cb3857546d5955307c651a177df86d167da6))





## [1.6.10](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.9...@proteinjs/db-driver-knex@1.6.10) (2026-04-07)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.8](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.7...@proteinjs/db-driver-knex@1.6.8) (2026-03-07)


### Bug Fixes

* `getColumnFactory` update now that `isInstanceOf` is a type guard. ([072019c](https://github.com/proteinjs/db/commit/072019c19ae5e9d7e1bb3ae218a15546c60167f1))
* Update `KnexColumnTypeFactory` and `SpannerColumnTypeFactory` to accommodate `isInstanceOf` becoming a type guard. ([833fb14](https://github.com/proteinjs/db/commit/833fb1474297b358a3a6bc52105ed86353314ad3))





## [1.6.7](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.6...@proteinjs/db-driver-knex@1.6.7) (2026-03-06)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.5](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.4...@proteinjs/db-driver-knex@1.6.5) (2026-02-12)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.4](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.3...@proteinjs/db-driver-knex@1.6.4) (2025-11-22)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.6.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.6.0...@proteinjs/db-driver-knex@1.6.1) (2025-11-13)


### Bug Fixes

* Any package (in this case, the drivers) that exports test utilities needs to import local source through the package (ie. `import { SpannerDriver' } from '@proteinjs/db-driver-spanner'`) in those utilities. Relative path imports to the src will result in type mismatches in the consuming package's test files. ([e92f361](https://github.com/proteinjs/db/commit/e92f361369d6cfee2657384ad543e1317caa124c))





# [1.6.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.5.0...@proteinjs/db-driver-knex@1.6.0) (2025-11-13)


### Bug Fixes

* Re-work db and drivers to separate test utils into a separate build (ie. @proteinjs/db/test). ([70c85e0](https://github.com/proteinjs/db/commit/70c85e0c1e3399e001d37be01adfd9ac13abd109))


### Features

* Expose `DB_LOG_LEVEL` so tests can ignore noisy logs like table creation. ([4799938](https://github.com/proteinjs/db/commit/4799938827c4c426655ff3936cbe72a1b9c2de4d))





# [1.5.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.4.15...@proteinjs/db-driver-knex@1.5.0) (2025-11-08)


### Features

* Reverse cascade delete ([#20](https://github.com/proteinjs/db/issues/20)) ([8aa734f](https://github.com/proteinjs/db/commit/8aa734f7c5cb2398ebced01f31cc62898d22aae0))





## [1.4.14](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.4.13...@proteinjs/db-driver-knex@1.4.14) (2025-09-28)


### Bug Fixes

* always use column name when creating indexes ([#18](https://github.com/proteinjs/db/issues/18)) ([6e80a8f](https://github.com/proteinjs/db/commit/6e80a8fe37ac3b92d7a9b6b60fa9239f5c504646))





## [1.4.13](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.4.12...@proteinjs/db-driver-knex@1.4.13) (2025-09-24)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.4.11](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.4.10...@proteinjs/db-driver-knex@1.4.11) (2025-09-09)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.4.10](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.4.9...@proteinjs/db-driver-knex@1.4.10) (2025-08-20)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.4.6](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.4.5...@proteinjs/db-driver-knex@1.4.6) (2025-04-24)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.4.4](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.4.3...@proteinjs/db-driver-knex@1.4.4) (2025-04-15)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.4.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.4.1...@proteinjs/db-driver-knex@1.4.2) (2025-04-02)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.4.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.4.0...@proteinjs/db-driver-knex@1.4.1) (2025-03-28)

**Note:** Version bump only for package @proteinjs/db-driver-knex





# [1.4.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.3.0...@proteinjs/db-driver-knex@1.4.0) (2025-02-07)


### Features

* Dynamic reference column ([#12](https://github.com/proteinjs/db/issues/12)) ([554b2e4](https://github.com/proteinjs/db/commit/554b2e4159f1d692d2ae976461c60f88639ecf22))





# [1.3.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.2.3...@proteinjs/db-driver-knex@1.3.0) (2024-12-11)


### Bug Fixes

* add transactionContextFactory to tests to bypass reflection error ([d8021f4](https://github.com/proteinjs/db/commit/d8021f4b5ed19f9bc536af8e62703d7ff51f635a))


### Features

* implement usage of new transaction context package in db and add it as dependency in db driver packages ([a1bc03a](https://github.com/proteinjs/db/commit/a1bc03ae7cde59237ab24a7cbb3e168b4425df9d))





## [1.2.3](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.2.2...@proteinjs/db-driver-knex@1.2.3) (2024-12-10)


### Bug Fixes

* `KnexDriver.start` make sure we create db if it doesn't exist; used by tests [skip ci] ([fd26e85](https://github.com/proteinjs/db/commit/fd26e851191f9dbc4be45c76abfcf102dde22632))





## [1.2.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.2.1...@proteinjs/db-driver-knex@1.2.2) (2024-11-07)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.2.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.2.0...@proteinjs/db-driver-knex@1.2.1) (2024-11-06)

**Note:** Version bump only for package @proteinjs/db-driver-knex





# [1.2.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.25...@proteinjs/db-driver-knex@1.2.0) (2024-10-31)


### Features

* transaction support version bump ([5908646](https://github.com/proteinjs/db/commit/59086469a2a9bb551fd86425f43f9900f6f9a3fc))





## [1.1.25](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.24...@proteinjs/db-driver-knex@1.1.25) (2024-10-21)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.24](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.23...@proteinjs/db-driver-knex@1.1.24) (2024-09-27)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.17](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.16...@proteinjs/db-driver-knex@1.1.17) (2024-08-16)


### Bug Fixes

* refactored to implement new @proteinjs/logger/Logger api ([66578f2](https://github.com/proteinjs/db/commit/66578f267d9293c0d5703c63e53d8edf68325f52))





## [1.1.16](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.15...@proteinjs/db-driver-knex@1.1.16) (2024-08-11)


### Bug Fixes

* reverted package versions to before failed publishes ([f63518c](https://github.com/proteinjs/db/commit/f63518cf27b74b53571254621dfe9df63aa94871))


### Reverts

* Revert "chore(release): publish [skip ci]" ([822bec0](https://github.com/proteinjs/db/commit/822bec053324b13522a6f754cf1f3771d8a24f8e))





## [1.1.16](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.15...@proteinjs/db-driver-knex@1.1.16) (2024-08-10)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.15](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.14...@proteinjs/db-driver-knex@1.1.15) (2024-08-07)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.12](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.11...@proteinjs/db-driver-knex@1.1.12) (2024-08-05)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.10](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.9...@proteinjs/db-driver-knex@1.1.10) (2024-08-02)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.9](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.8...@proteinjs/db-driver-knex@1.1.9) (2024-07-29)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.6](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.5...@proteinjs/db-driver-knex@1.1.6) (2024-07-11)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.5](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.4...@proteinjs/db-driver-knex@1.1.5) (2024-07-09)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.3](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.2...@proteinjs/db-driver-knex@1.1.3) (2024-07-06)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.1.1](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.1.0...@proteinjs/db-driver-knex@1.1.1) (2024-06-27)

**Note:** Version bump only for package @proteinjs/db-driver-knex





# [1.1.0](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.28...@proteinjs/db-driver-knex@1.1.0) (2024-06-27)


### Bug Fixes

* use the same version of moment ([62ffa76](https://github.com/proteinjs/db/commit/62ffa765a84ee0325f7ff5194fc898f74f43cfd8))


### Features

* add case sensitivity control to condition ([#4](https://github.com/proteinjs/db/issues/4)) ([13da747](https://github.com/proteinjs/db/commit/13da7477be6216d4449311ad3a68ef3cde246d45))





## [1.0.28](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.27...@proteinjs/db-driver-knex@1.0.28) (2024-06-24)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.0.27](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.26...@proteinjs/db-driver-knex@1.0.27) (2024-06-19)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.0.26](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.25...@proteinjs/db-driver-knex@1.0.26) (2024-06-19)


### Bug Fixes

* handle undefined values when building a condition, querying, inserting, updating, or deleting and allow null in all column types ([#2](https://github.com/proteinjs/db/issues/2)) ([7edda4e](https://github.com/proteinjs/db/commit/7edda4e6e39a4c75fc70122daeb205a79eccc173))





## [1.0.25](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.24...@proteinjs/db-driver-knex@1.0.25) (2024-06-15)


### Bug Fixes

* Allow null values to be passed into Spanner DML ([#1](https://github.com/proteinjs/db/issues/1)) ([db1def2](https://github.com/proteinjs/db/commit/db1def2610298309911e8edc1e1c1497dbf2f7a7))





## [1.0.24](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.23...@proteinjs/db-driver-knex@1.0.24) (2024-06-02)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.0.22](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.21...@proteinjs/db-driver-knex@1.0.22) (2024-05-24)

**Note:** Version bump only for package @proteinjs/db-driver-knex





## [1.0.19](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.18...@proteinjs/db-driver-knex@1.0.19) (2024-05-17)


### Bug Fixes

* update settings table to be a scoped table ([db57b82](https://github.com/proteinjs/db/commit/db57b82dafe32b1111592837696216c9bb45b4fc))





## [1.0.16](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.15...@proteinjs/db-driver-knex@1.0.16) (2024-05-10)


### Bug Fixes

* add .md file type to lint ignore files ([9460a31](https://github.com/proteinjs/db/commit/9460a313cd418250115922f687277f1b01dce238))





## [1.0.15](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.14...@proteinjs/db-driver-knex@1.0.15) (2024-05-10)


### Bug Fixes

* add linting and lint all files ([f9859a3](https://github.com/proteinjs/db/commit/f9859a39882376fe7b93aa3b4281b22b2c02b7d5))





## [1.0.14](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.13...@proteinjs/db-driver-knex@1.0.14) (2024-05-09)

**Note:** Version bump only for package @proteinjs/db-driver-knex

## [1.0.12](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.11...@proteinjs/db-driver-knex@1.0.12) (2024-05-03)

**Note:** Version bump only for package @proteinjs/db-driver-knex

## [1.0.11](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.10...@proteinjs/db-driver-knex@1.0.11) (2024-05-02)

### Bug Fixes

- db now requires a `DefaultDbDriverFactory` implementation to get default driver ([29daebd](https://github.com/proteinjs/db/commit/29daebdd971b106142eb525380f5a7d12a3d8eb6))

## [1.0.8](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.7...@proteinjs/db-driver-knex@1.0.8) (2024-04-26)

**Note:** Version bump only for package @proteinjs/db-driver-knex

## [1.0.7](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.6...@proteinjs/db-driver-knex@1.0.7) (2024-04-26)

### Bug Fixes

- `SchemaMetadata.tableExists` include condition to query `TABLE_SCHEMA` by default for mysql ([b4e6d22](https://github.com/proteinjs/db/commit/b4e6d224d93db75c83ad75160b83346f2b12d166))

## [1.0.2](https://github.com/proteinjs/db/compare/@proteinjs/db-driver-knex@1.0.1...@proteinjs/db-driver-knex@1.0.2) (2024-04-19)

**Note:** Version bump only for package @proteinjs/db-driver-knex

## 1.0.1 (2024-04-19)

**Note:** Version bump only for package @proteinjs/db-driver-knex
