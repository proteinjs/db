# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.2.2](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.2.1...@proteinjs/db-query@1.2.2) (2024-07-09)


### Bug Fixes

* `QueryBuilder.fromQueryBuilder` needed to not overwrite the new graph and also pass the `currentContextIds` array prop by value ([714bb82](https://github.com/proteinjs/db/commit/714bb82aaf381434226e9a39d891862dc0dbef59))





# [1.2.0](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.1.1...@proteinjs/db-query@1.2.0) (2024-07-06)


### Features

* utilize react query and add infinite scroll to table ([#6](https://github.com/proteinjs/db/issues/6)) ([7244a68](https://github.com/proteinjs/db/commit/7244a68fbce5ca1270321c6c63366ea4f3d97b63))





# [1.1.0](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.0.15...@proteinjs/db-query@1.1.0) (2024-06-27)


### Bug Fixes

* updating packages for db changes ([2328d68](https://github.com/proteinjs/db/commit/2328d68865e3315f73ecf4c98c227127bedc699c))


### Features

* add case sensitivity control to condition ([#4](https://github.com/proteinjs/db/issues/4)) ([13da747](https://github.com/proteinjs/db/commit/13da7477be6216d4449311ad3a68ef3cde246d45))





## [1.0.15](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.0.14...@proteinjs/db-query@1.0.15) (2024-06-24)


### Bug Fixes

* `QueryBuilder` and `StatementFactory` should escape values with backticks where appropriate. This allows you to define column or table names that would otherwise conflict with reserved words in the db engine (ie. having a colmn named `order`). ([3745d64](https://github.com/proteinjs/db/commit/3745d644fb0997df6f27f049948f5d9073a1f343))





## [1.0.14](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.0.13...@proteinjs/db-query@1.0.14) (2024-06-19)


### Bug Fixes

* handle undefined values when building a condition, querying, inserting, updating, or deleting and allow null in all column types ([#2](https://github.com/proteinjs/db/issues/2)) ([7edda4e](https://github.com/proteinjs/db/commit/7edda4e6e39a4c75fc70122daeb205a79eccc173))





## [1.0.13](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.0.12...@proteinjs/db-query@1.0.13) (2024-06-15)


### Bug Fixes

* Allow null values to be passed into Spanner DML ([#1](https://github.com/proteinjs/db/issues/1)) ([db1def2](https://github.com/proteinjs/db/commit/db1def2610298309911e8edc1e1c1497dbf2f7a7))





## [1.0.12](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.0.11...@proteinjs/db-query@1.0.12) (2024-05-17)


### Bug Fixes

* update settings table to be a scoped table ([db57b82](https://github.com/proteinjs/db/commit/db57b82dafe32b1111592837696216c9bb45b4fc))





## [1.0.10](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.0.9...@proteinjs/db-query@1.0.10) (2024-05-10)


### Bug Fixes

* add .md file type to lint ignore files ([9460a31](https://github.com/proteinjs/db/commit/9460a313cd418250115922f687277f1b01dce238))





## [1.0.9](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.0.8...@proteinjs/db-query@1.0.9) (2024-05-10)


### Bug Fixes

* add linting and lint all files ([f9859a3](https://github.com/proteinjs/db/commit/f9859a39882376fe7b93aa3b4281b22b2c02b7d5))





## [1.0.2](https://github.com/proteinjs/db/compare/@proteinjs/db-query@1.0.1...@proteinjs/db-query@1.0.2) (2024-04-19)

**Note:** Version bump only for package @proteinjs/db-query

## 1.0.1 (2024-04-19)

**Note:** Version bump only for package @proteinjs/db-query
