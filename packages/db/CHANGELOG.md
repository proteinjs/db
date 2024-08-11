# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
