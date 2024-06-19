# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
