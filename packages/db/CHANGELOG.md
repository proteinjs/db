# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.19.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.18.2...@proteinjs/db@1.19.0) (2025-11-08)


### Features

* Reverse cascade delete ([#20](https://github.com/proteinjs/db/issues/20)) ([8aa734f](https://github.com/proteinjs/db/commit/8aa734f7c5cb2398ebced01f31cc62898d22aae0))





## [1.18.1](https://github.com/proteinjs/db/compare/@proteinjs/db@1.18.0...@proteinjs/db@1.18.1) (2025-09-28)


### Bug Fixes

* always use column name when creating indexes ([#18](https://github.com/proteinjs/db/issues/18)) ([6e80a8f](https://github.com/proteinjs/db/commit/6e80a8fe37ac3b92d7a9b6b60fa9239f5c504646))
* remove duplicate query logic ([#17](https://github.com/proteinjs/db/issues/17)) ([1bd0ecf](https://github.com/proteinjs/db/commit/1bd0ecfd88bf203e6d8b9659935fbd79e4f2f9fd))





# [1.18.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.17.1...@proteinjs/db@1.18.0) (2025-09-24)


### Features

* provide operation context to column queries ([#16](https://github.com/proteinjs/db/issues/16)) ([b7c7d3b](https://github.com/proteinjs/db/commit/b7c7d3bc051f3907a917fe67ad9ee4008e61f13c))





# [1.17.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.16.0...@proteinjs/db@1.17.0) (2025-09-09)


### Features

* enhance TableWatcher API with query mutation capabilities ([b47f903](https://github.com/proteinjs/db/commit/b47f9038caed678ca2cbc66cb4b1f9aa9eb85518))





# [1.16.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.15.3...@proteinjs/db@1.16.0) (2025-08-20)


### Features

* Run onBeforeInsert during insert ([c736f62](https://github.com/proteinjs/db/commit/c736f625b7bbee5f02ad364228c7175699e46dff))





# [1.15.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.14.3...@proteinjs/db@1.15.0) (2025-04-24)


### Features

* Added `QueryOptions` to `Db.query`, `Db.get`, and `QueryTableLoader`. Specifically, added the `preloadReferences` option that enables the caller to specify how references (field values of type `Reference` and `ReferenceArray`) are preloaded. ([8f42373](https://github.com/proteinjs/db/commit/8f42373093eb42114de76bffbb7d735f5b33402c))





## [1.14.2](https://github.com/proteinjs/db/compare/@proteinjs/db@1.14.1...@proteinjs/db@1.14.2) (2025-04-15)


### Bug Fixes

* `ReferenceCache` updated typings of `setMultiple` and `reloadTable` to be constrained by `T` ([26108cf](https://github.com/proteinjs/db/commit/26108cfd5b4429a52166ca3c8359dcbce62d99d1))





# [1.14.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.13.0...@proteinjs/db@1.14.0) (2025-04-02)


### Features

* Expose `Db.getDefaultDbDriver` for ease of access ([e454264](https://github.com/proteinjs/db/commit/e454264bdf4232eac9bbe28328d9494f7ecf8fc7))





# [1.13.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.12.0...@proteinjs/db@1.13.0) (2025-03-28)


### Bug Fixes

* simplify validation for column table name in validateDynamicReferenceColumns ([899d149](https://github.com/proteinjs/db/commit/899d149d87de7356ee488e169003a473a6f8b950))


### Features

* `Transaction.delete` added support for updating the cached db when a `QueryBuilder` with a `id IN string[]` condition is passed in. ([211ba0f](https://github.com/proteinjs/db/commit/211ba0f6dfa1e10c281b4c9d2367af57d695b956))





# [1.12.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.11.0...@proteinjs/db@1.12.0) (2025-02-07)


### Bug Fixes

* TransactionRunnerService auth for authenticated users instead of only admin ([497e13e](https://github.com/proteinjs/db/commit/497e13efbb196bf1a20c593a296a695005e89de4))


### Features

* Dynamic reference column ([#12](https://github.com/proteinjs/db/issues/12)) ([554b2e4](https://github.com/proteinjs/db/commit/554b2e4159f1d692d2ae976461c60f88639ecf22))





# [1.11.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.10.0...@proteinjs/db@1.11.0) (2024-12-11)


### Bug Fixes

* add transactionContextFactory to tests to bypass reflection error ([d8021f4](https://github.com/proteinjs/db/commit/d8021f4b5ed19f9bc536af8e62703d7ff51f635a))
* fixing api for Transaction Context runInContext ([a66dfed](https://github.com/proteinjs/db/commit/a66dfed178b6a3b7f431849b26dd1139e4f3f9ff))


### Features

* implement usage of new transaction context package in db and add it as dependency in db driver packages ([a1bc03a](https://github.com/proteinjs/db/commit/a1bc03ae7cde59237ab24a7cbb3e168b4425df9d))





# [1.10.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.9.1...@proteinjs/db@1.10.0) (2024-12-10)


### Features

* retrieve DefaultTransactionContextFactory via reflection ([bd158bf](https://github.com/proteinjs/db/commit/bd158bf41c2976640bd74e1f079896554775e707))





## [1.9.1](https://github.com/proteinjs/db/compare/@proteinjs/db@1.9.0...@proteinjs/db@1.9.1) (2024-11-07)


### Bug Fixes

* `Transaction.update` no longer throws when updating a record not in the cached db, instead no-ops; it's valid to not care about the cached db when using `Transaction`. ([27089d6](https://github.com/proteinjs/db/commit/27089d6b1e99c3a6b37eae94655c5a8092faed3d))
* adjusted `TransactionDb` tests expectations ([8f30fa1](https://github.com/proteinjs/db/commit/8f30fa118486b6a8d9a571d79b7c813c58875b51))





# [1.9.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.8.0...@proteinjs/db@1.9.0) (2024-11-06)


### Features

* `ColumnOptions.forceDefaultValue` now optionally takes a function `(runAsSystem: boolean) => boolean` to provide more control to the column over how it handles enforcing default values on insert ([7f8f30a](https://github.com/proteinjs/db/commit/7f8f30a98bce496d5ca3254a69c1bc54a90bc460))





# [1.8.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.7.0...@proteinjs/db@1.8.0) (2024-10-31)


### Features

* transaction support version bump ([5908646](https://github.com/proteinjs/db/commit/59086469a2a9bb551fd86425f43f9900f6f9a3fc))





# [1.7.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.6.0...@proteinjs/db@1.7.0) (2024-10-21)


### Features

* added `Reference.getIfExists` ([a94c214](https://github.com/proteinjs/db/commit/a94c214089739f9527d1e6f6301b1fa2869c6c70))





# [1.6.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.5.13...@proteinjs/db@1.6.0) (2024-09-27)


### Features

* table updates; RecordIterator accepts optional db constructor param ([#10](https://github.com/proteinjs/db/issues/10)) ([6f963c4](https://github.com/proteinjs/db/commit/6f963c4daaa1f6fcff18cbc5714be6ed9d3b42f7))





## [1.5.7](https://github.com/proteinjs/db/compare/@proteinjs/db@1.5.6...@proteinjs/db@1.5.7) (2024-08-16)


### Bug Fixes

* refactored to implement new @proteinjs/logger/Logger api ([66578f2](https://github.com/proteinjs/db/commit/66578f267d9293c0d5703c63e53d8edf68325f52))





## [1.5.6](https://github.com/proteinjs/db/compare/@proteinjs/db@1.5.5...@proteinjs/db@1.5.6) (2024-08-11)


### Bug Fixes

* `RecordSerializer` now only logs omitted fields in debug mode. it's expected behavior when tables are extended and logs a lot. ([8462005](https://github.com/proteinjs/db/commit/8462005bcf459ef7e8ec2d4fa687a41798db17a4))
* reverted package versions to before failed publishes ([f63518c](https://github.com/proteinjs/db/commit/f63518cf27b74b53571254621dfe9df63aa94871))
* should however warn when fields are skipped when serializing a record going into the db. the developer may be sending in a different object than they think ([7c52a76](https://github.com/proteinjs/db/commit/7c52a76980dc68f1ef1260c9824492bf2bd16c57))
* trigger a publish after npm access token refresh ([c19cdb0](https://github.com/proteinjs/db/commit/c19cdb0f0a1bdc2f5aa5f31c8bb49e140beb5a21))


### Reverts

* Revert "chore(release): publish [skip ci]" ([822bec0](https://github.com/proteinjs/db/commit/822bec053324b13522a6f754cf1f3771d8a24f8e))





## [1.5.6](https://github.com/proteinjs/db/compare/@proteinjs/db@1.5.5...@proteinjs/db@1.5.6) (2024-08-10)


### Bug Fixes

* `RecordSerializer` now only logs omitted fields in debug mode. it's expected behavior when tables are extended and logs a lot. ([8462005](https://github.com/proteinjs/db/commit/8462005bcf459ef7e8ec2d4fa687a41798db17a4))





## [1.5.5](https://github.com/proteinjs/db/compare/@proteinjs/db@1.5.4...@proteinjs/db@1.5.5) (2024-08-07)


### Bug Fixes

* remove unnecessary log statement in `ReferenceArrayColumn.serialize` ([0d369bd](https://github.com/proteinjs/db/commit/0d369bdc0df2f585dadf9a7bd5d74df700031162))





## [1.5.2](https://github.com/proteinjs/db/compare/@proteinjs/db@1.5.1...@proteinjs/db@1.5.2) (2024-08-05)


### Bug Fixes

* `RecordIterator` now correctly calculates `pagination.end`. i don't think it was ever reading past the first page since the first page of `results.length` would always be less than `pageSize`.. ([2a23c04](https://github.com/proteinjs/db/commit/2a23c0488f58588a7581413457b40e9a347500e5))





# [1.5.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.4.0...@proteinjs/db@1.5.0) (2024-08-02)


### Features

* added `DbInitStartupTask` to init the db if the consuming app is using `@proteinjs/server` ([5d076a1](https://github.com/proteinjs/db/commit/5d076a1574f9dd6bd3c8111efb20d3ce67475ef9))





# [1.4.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.3.3...@proteinjs/db@1.4.0) (2024-07-29)


### Features

* remove createProxy in ReferenceArray and add additional helper functions ([#9](https://github.com/proteinjs/db/issues/9)) ([bf00e2e](https://github.com/proteinjs/db/commit/bf00e2eeedd5f6d96bc64461bd3c4136a2b3a015))





## [1.3.1](https://github.com/proteinjs/db/compare/@proteinjs/db@1.3.0...@proteinjs/db@1.3.1) (2024-07-11)


### Bug Fixes

* `ReferenceArrayColumn.serialize` should not perform queries. it should be able to rely on the integrity of `ReferenceArray._ids`. ([dc1aa27](https://github.com/proteinjs/db/commit/dc1aa27883d9c9a8d22f4aa609594d8c485f7d29))
* fisabled eslint for this line `const referenceArray = this;` ([9c1502b](https://github.com/proteinjs/db/commit/9c1502b9205fae9f3e6563145f5b9268ae478273))





# [1.3.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.2.1...@proteinjs/db@1.3.0) (2024-07-09)


### Features

* added `TableWatcher` api ([1544e28](https://github.com/proteinjs/db/commit/1544e284ad712e2606c82606f2501041f34517cb))





# [1.2.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.1.1...@proteinjs/db@1.2.0) (2024-07-06)


### Bug Fixes

* updating package version ([3ae7167](https://github.com/proteinjs/db/commit/3ae71672eac5d394e6acf48d6b44e1e05732dd85))


### Features

* utilize react query and add infinite scroll to table ([#6](https://github.com/proteinjs/db/issues/6)) ([7244a68](https://github.com/proteinjs/db/commit/7244a68fbce5ca1270321c6c63366ea4f3d97b63))





# [1.1.0](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.29...@proteinjs/db@1.1.0) (2024-06-27)


### Bug Fixes

* updating packages for db changes ([2328d68](https://github.com/proteinjs/db/commit/2328d68865e3315f73ecf4c98c227127bedc699c))


### Features

* add case sensitivity control to condition ([#4](https://github.com/proteinjs/db/issues/4)) ([13da747](https://github.com/proteinjs/db/commit/13da7477be6216d4449311ad3a68ef3cde246d45))





## [1.0.29](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.28...@proteinjs/db@1.0.29) (2024-06-24)


### Bug Fixes

* `QueryBuilder` and `StatementFactory` should escape values with backticks where appropriate. This allows you to define column or table names that would otherwise conflict with reserved words in the db engine (ie. having a colmn named `order`). ([3745d64](https://github.com/proteinjs/db/commit/3745d644fb0997df6f27f049948f5d9073a1f343))





## [1.0.28](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.27...@proteinjs/db@1.0.28) (2024-06-19)


### Bug Fixes

* adjust tests for ReferenceArrayColumn ([c333960](https://github.com/proteinjs/db/commit/c3339605d3184c265142dbfabb8e9e854dd3c27c))
* set empty array instead of null for reference array col ([719a768](https://github.com/proteinjs/db/commit/719a768307dd75d61d02d11053b6b743132fc50d))





## [1.0.27](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.26...@proteinjs/db@1.0.27) (2024-06-19)


### Bug Fixes

* handle undefined values when building a condition, querying, inserting, updating, or deleting and allow null in all column types ([#2](https://github.com/proteinjs/db/issues/2)) ([7edda4e](https://github.com/proteinjs/db/commit/7edda4e6e39a4c75fc70122daeb205a79eccc173))





## [1.0.26](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.25...@proteinjs/db@1.0.26) (2024-06-15)


### Bug Fixes

* Allow null values to be passed into Spanner DML ([#1](https://github.com/proteinjs/db/issues/1)) ([db1def2](https://github.com/proteinjs/db/commit/db1def2610298309911e8edc1e1c1497dbf2f7a7))





## [1.0.25](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.24...@proteinjs/db@1.0.25) (2024-06-02)

**Note:** Version bump only for package @proteinjs/db





## [1.0.23](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.22...@proteinjs/db@1.0.23) (2024-05-24)


### Bug Fixes

* `Db.update` should add column queries to its update query ([d1ebb77](https://github.com/proteinjs/db/commit/d1ebb777a13472f2968acc44a4ca0b32c08a5969))





## [1.0.20](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.19...@proteinjs/db@1.0.20) (2024-05-17)


### Bug Fixes

* update settings table to be a scoped table ([db57b82](https://github.com/proteinjs/db/commit/db57b82dafe32b1111592837696216c9bb45b4fc))





## [1.0.17](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.16...@proteinjs/db@1.0.17) (2024-05-10)


### Bug Fixes

* add .md file type to lint ignore files ([9460a31](https://github.com/proteinjs/db/commit/9460a313cd418250115922f687277f1b01dce238))





## [1.0.16](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.15...@proteinjs/db@1.0.16) (2024-05-10)


### Bug Fixes

* add linting and lint all files ([f9859a3](https://github.com/proteinjs/db/commit/f9859a39882376fe7b93aa3b4281b22b2c02b7d5))





## [1.0.15](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.14...@proteinjs/db@1.0.15) (2024-05-09)

### Bug Fixes

- `SpannerColumnTypeFactory` a `DateColumn` should also be a `TIMESTAMP` in spanner ([29e8b36](https://github.com/proteinjs/db/commit/29e8b36edf2911e0188180d73fa11116482f42ac))

## [1.0.13](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.12...@proteinjs/db@1.0.13) (2024-05-03)

**Note:** Version bump only for package @proteinjs/db

## [1.0.12](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.11...@proteinjs/db@1.0.12) (2024-05-02)

### Bug Fixes

- db now requires a `DefaultDbDriverFactory` implementation to get default driver ([29daebd](https://github.com/proteinjs/db/commit/29daebdd971b106142eb525380f5a7d12a3d8eb6))

## [1.0.9](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.8...@proteinjs/db@1.0.9) (2024-04-26)

### Bug Fixes

- remove `instanceof` calls in .tsx files; add ui hiding config to corresponding columns ([19c818e](https://github.com/proteinjs/db/commit/19c818eed74197834474231042f51da0a9fe21ed))

## [1.0.8](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.7...@proteinjs/db@1.0.8) (2024-04-26)

### Bug Fixes

- `SchemaMetadata.tableExists` include condition to query `TABLE_SCHEMA` by default for mysql ([b4e6d22](https://github.com/proteinjs/db/commit/b4e6d224d93db75c83ad75160b83346f2b12d166))

## [1.0.3](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.2...@proteinjs/db@1.0.3) (2024-04-19)

**Note:** Version bump only for package @proteinjs/db

## [1.0.2](https://github.com/proteinjs/db/compare/@proteinjs/db@1.0.1...@proteinjs/db@1.0.2) (2024-04-19)

**Note:** Version bump only for package @proteinjs/db

## 1.0.1 (2024-04-19)

**Note:** Version bump only for package @proteinjs/db
