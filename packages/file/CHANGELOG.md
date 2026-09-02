# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.7.13](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.12...@proteinjs/db-file@1.7.13) (2026-09-02)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.12](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.11...@proteinjs/db-file@1.7.12) (2026-09-02)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.11](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.10...@proteinjs/db-file@1.7.11) (2026-09-02)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.10](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.9...@proteinjs/db-file@1.7.10) (2026-09-01)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.9](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.8...@proteinjs/db-file@1.7.9) (2026-08-31)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.8](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.7...@proteinjs/db-file@1.7.8) (2026-08-29)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.7](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.6...@proteinjs/db-file@1.7.7) (2026-08-29)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.6](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.5...@proteinjs/db-file@1.7.6) (2026-08-29)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.5](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.4...@proteinjs/db-file@1.7.5) (2026-08-28)


### Bug Fixes

* file byte access gates on the file row — the browser-facing byte ops refuse ids whose row the caller cannot reach ([3ba4a7c](https://github.com/proteinjs/db/commit/3ba4a7cf50d5055998ea3ccc479068fe8262aad0))





## [1.7.4](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.3...@proteinjs/db-file@1.7.4) (2026-08-28)


### Bug Fixes

* file access derives from content access — shared-content reachability leg on the file read ([0f9a480](https://github.com/proteinjs/db/commit/0f9a48047971ba4381692420bb69e834ffa1d8e7))





## [1.7.3](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.2...@proteinjs/db-file@1.7.3) (2026-08-28)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.2](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.1...@proteinjs/db-file@1.7.2) (2026-08-27)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.1](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.0...@proteinjs/db-file@1.7.1) (2026-08-26)

**Note:** Version bump only for package @proteinjs/db-file





# [1.7.0](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.6.1...@proteinjs/db-file@1.7.0) (2026-08-26)


### Features

* HTTP Range on the file proxy route — video seek parity with signed-URL serving ([0a95a3f](https://github.com/proteinjs/db/commit/0a95a3f355411b68a20b5cfbc7d7614962b3cd40))





## [1.6.1](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.6.0...@proteinjs/db-file@1.6.1) (2026-08-24)

**Note:** Version bump only for package @proteinjs/db-file





# [1.6.0](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.5.3...@proteinjs/db-file@1.6.0) (2026-08-23)


### Features

* File web provenance + content hash — source_url/source_page_url/retrieved_at columns, scoped content_hash dedup index ([8fd4221](https://github.com/proteinjs/db/commit/8fd422181320e247d2776fa15d66a43010491fb3))





## [1.5.3](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.5.2...@proteinjs/db-file@1.5.3) (2026-08-23)

**Note:** Version bump only for package @proteinjs/db-file





## [1.5.2](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.5.1...@proteinjs/db-file@1.5.2) (2026-08-19)

**Note:** Version bump only for package @proteinjs/db-file





## [1.5.1](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.5.0...@proteinjs/db-file@1.5.1) (2026-08-19)

**Note:** Version bump only for package @proteinjs/db-file





# [1.5.0](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.15...@proteinjs/db-file@1.5.0) (2026-08-18)


### Features

* file bytes die with file rows — deleteFile is a required FileStorageDriver capability ([6d64305](https://github.com/proteinjs/db/commit/6d64305ec43cfaaa8aeb11490c548e803db8a14d))
* signed-URL file serving — GET /file/:id 302-redirects to the blob store, true bytes at rest, media metadata columns ([fa61db9](https://github.com/proteinjs/db/commit/fa61db9d11793a39ead08254d87c5168702b2035))





## [1.4.15](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.14...@proteinjs/db-file@1.4.15) (2026-08-17)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.14](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.13...@proteinjs/db-file@1.4.14) (2026-08-15)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.13](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.12...@proteinjs/db-file@1.4.13) (2026-08-15)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.12](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.11...@proteinjs/db-file@1.4.12) (2026-08-15)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.11](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.10...@proteinjs/db-file@1.4.11) (2026-08-14)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.10](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.9...@proteinjs/db-file@1.4.10) (2026-08-14)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.9](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.8...@proteinjs/db-file@1.4.9) (2026-08-14)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.8](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.7...@proteinjs/db-file@1.4.8) (2026-08-14)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.7](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.6...@proteinjs/db-file@1.4.7) (2026-08-13)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.6](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.5...@proteinjs/db-file@1.4.6) (2026-08-13)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.5](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.4...@proteinjs/db-file@1.4.5) (2026-08-13)

**Note:** Version bump only for package @proteinjs/db-file





## [1.4.1](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.4.0...@proteinjs/db-file@1.4.1) (2026-08-08)

**Note:** Version bump only for package @proteinjs/db-file





## [1.3.7](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.3.6...@proteinjs/db-file@1.3.7) (2026-07-28)

**Note:** Version bump only for package @proteinjs/db-file





## [1.3.6](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.3.5...@proteinjs/db-file@1.3.6) (2026-07-25)


### Bug Fixes

* **db-file:** a zero-byte file serves 200, not 404 ([7407783](https://github.com/proteinjs/db/commit/740778304ca33a356601a5df51fc00c3f1eacc8e))





## [1.3.5](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.3.4...@proteinjs/db-file@1.3.5) (2026-07-24)

**Note:** Version bump only for package @proteinjs/db-file





## [1.3.4](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.3.3...@proteinjs/db-file@1.3.4) (2026-07-24)

**Note:** Version bump only for package @proteinjs/db-file





## [1.3.2](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.3.1...@proteinjs/db-file@1.3.2) (2026-07-21)

**Note:** Version bump only for package @proteinjs/db-file





## [1.3.1](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.3.0...@proteinjs/db-file@1.3.1) (2026-07-10)

**Note:** Version bump only for package @proteinjs/db-file





# [1.3.0](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.49...@proteinjs/db-file@1.3.0) (2026-06-19)


### Features

* add optional preview self-reference to File table ([77c52d4](https://github.com/proteinjs/db/commit/77c52d4fd84b0029553f09af28bd17046609ad91))





## [1.2.47](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.46...@proteinjs/db-file@1.2.47) (2026-04-18)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.42](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.41...@proteinjs/db-file@1.2.42) (2026-04-08)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.41](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.40...@proteinjs/db-file@1.2.41) (2026-04-07)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.39](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.38...@proteinjs/db-file@1.2.39) (2026-03-06)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.37](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.36...@proteinjs/db-file@1.2.37) (2026-02-12)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.35](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.34...@proteinjs/db-file@1.2.35) (2025-11-22)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.32](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.31...@proteinjs/db-file@1.2.32) (2025-11-13)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.31](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.30...@proteinjs/db-file@1.2.31) (2025-11-08)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.26](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.25...@proteinjs/db-file@1.2.26) (2025-09-28)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.22](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.21...@proteinjs/db-file@1.2.22) (2025-09-24)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.19](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.18...@proteinjs/db-file@1.2.19) (2025-09-09)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.15](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.14...@proteinjs/db-file@1.2.15) (2025-08-20)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.10](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.9...@proteinjs/db-file@1.2.10) (2025-04-24)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.7](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.6...@proteinjs/db-file@1.2.7) (2025-04-15)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.5](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.4...@proteinjs/db-file@1.2.5) (2025-04-02)

**Note:** Version bump only for package @proteinjs/db-file





## [1.2.3](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.2.2...@proteinjs/db-file@1.2.3) (2025-03-28)

**Note:** Version bump only for package @proteinjs/db-file





# [1.2.0](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.38...@proteinjs/db-file@1.2.0) (2025-02-07)


### Features

* Dynamic reference column ([#12](https://github.com/proteinjs/db/issues/12)) ([554b2e4](https://github.com/proteinjs/db/commit/554b2e4159f1d692d2ae976461c60f88639ecf22))





## [1.1.37](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.36...@proteinjs/db-file@1.1.37) (2024-12-11)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.35](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.34...@proteinjs/db-file@1.1.35) (2024-12-10)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.33](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.32...@proteinjs/db-file@1.1.33) (2024-11-07)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.31](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.30...@proteinjs/db-file@1.1.31) (2024-11-06)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.29](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.28...@proteinjs/db-file@1.1.29) (2024-10-31)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.27](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.26...@proteinjs/db-file@1.1.27) (2024-10-21)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.26](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.25...@proteinjs/db-file@1.1.26) (2024-10-03)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.24](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.23...@proteinjs/db-file@1.1.24) (2024-09-27)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.17](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.16...@proteinjs/db-file@1.1.17) (2024-08-16)


### Bug Fixes

* refactored to implement new @proteinjs/logger/Logger api ([66578f2](https://github.com/proteinjs/db/commit/66578f267d9293c0d5703c63e53d8edf68325f52))





## [1.1.15](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.14...@proteinjs/db-file@1.1.15) (2024-08-11)


### Bug Fixes

* reverted package versions to before failed publishes ([f63518c](https://github.com/proteinjs/db/commit/f63518cf27b74b53571254621dfe9df63aa94871))


### Reverts

* Revert "chore(release): publish [skip ci]" ([822bec0](https://github.com/proteinjs/db/commit/822bec053324b13522a6f754cf1f3771d8a24f8e))





## [1.1.15](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.14...@proteinjs/db-file@1.1.15) (2024-08-10)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.13](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.12...@proteinjs/db-file@1.1.13) (2024-08-07)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.10](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.9...@proteinjs/db-file@1.1.10) (2024-08-05)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.8](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.7...@proteinjs/db-file@1.1.8) (2024-08-02)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.6](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.5...@proteinjs/db-file@1.1.6) (2024-07-29)

**Note:** Version bump only for package @proteinjs/db-file





## [1.1.2](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.1.1...@proteinjs/db-file@1.1.2) (2024-07-11)

**Note:** Version bump only for package @proteinjs/db-file





# 1.1.0 (2024-07-09)


### Bug Fixes

* `getFile` should only work for authenticated users ([97a6e22](https://github.com/proteinjs/db/commit/97a6e22c289c2acb64b31c8c8800fa1b933f5c40))


### Features

* added `TableWatcher` api ([1544e28](https://github.com/proteinjs/db/commit/1544e284ad712e2606c82606f2501041f34517cb))
