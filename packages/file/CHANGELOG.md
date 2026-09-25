# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.9.0](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.8.4...@proteinjs/db-file@1.9.0) (2026-09-25)


### Bug Fixes

* **db-file:** a file no copy can be made of answers a quiet 403 on GET /file/:id — it was a 500 with the refusal's stack printed on every view (a recipient looking at a shared camera RAW would raise an error report per look). FileCopyRefused is the seam's own refusal: FileStorage throws it in the maker's place with the maker's one-line reason, read by shape like FileStorageError; the route maps it, nothing printed; the browser service still throws it to its caller. Red first: the route case answered 500 ([936af9e](https://github.com/proteinjs/db/commit/936af9e58dbe1d0f672eeac41433e4f514b2b729))
* **db-file:** a file that is not there answers what a refused copy answers — 404 "File not found" at every door, never the id ([d5e484c](https://github.com/proteinjs/db/commit/d5e484c0b8456fd67d704cbaa96799feef47d87f))
* **db-file:** a refused copy answers only "File not found" at every door — the maker's reason stays in the server's log ([d4902f6](https://github.com/proteinjs/db/commit/d4902f6ce1d5b3e6daa609abab2bbf0eb9a4027a))
* **db-file:** a storage driver's errors are the driver's own — a code, a plain message, the status ([a111158](https://github.com/proteinjs/db/commit/a11115825085860c1578196675497429cd2fb930))
* **db-file:** deriveVariants hands back the caller's row with the variants named on it, not a re-read — an unset column stays unset (a consumer that returns the inserted row saw null where it had undefined); one read fewer at ingest ([763809c](https://github.com/proteinjs/db/commit/763809cc59b6d804f475bf8882a00d4d48ab113f))
* **db-file:** one refusal at every file door — a file no copy can be made of is a 404 for anyone but its owner, whichever door asks ([382fa26](https://github.com/proteinjs/db/commit/382fa2648e0627b13f728c16d1b018a501557791))
* **db-file:** the owner of a served file is read from the row's scope, not from a second read — getFile stays the one access decision every consumer stubs; a row with no owner recorded serves as itself ([133286b](https://github.com/proteinjs/db/commit/133286bb5178a5552704b76aa076ead3663f9f3e))
* **db-file:** the read path derives a variant once per file and kind at a time in a process — N readers asking for the same absent stage while it derives (a shared document opened by many on one tick) each read the original, ran the maker, stored an object and had the row's word discard all but one; now they wait for the one derivation's answer (four readers: one read, one maker call, one object, no loser). Across processes the row's word in one transaction still decides. A maker that cannot make the variant of these bytes no longer fails the read with a 500 per look: FileVariantNotMade is the seam's own refusal (the maker's one-line reason on it, read by shape like FileCopyRefused); the read path serves the file itself and says so in the log, the ingest door still reports it to the caller holding the bytes. Red first: four readers cost four maker calls; the maker's throw escaped getVariant ([b9cca11](https://github.com/proteinjs/db/commit/b9cca11148c1ec8985caf9157de1eab3f37e0faa))
* **db-file:** the row's word for a copy for others is decided in one transaction — two non-owners racing both passed the re-read and a second (third, fourth) copy stayed alive in the owner's scope, never named on the row and so never cascade-deleted; the read of the row and the write of its word now ride one transaction (the loser's transaction is retried and finds the winner named), the loser's row is deleted after the commit. The suite gains the race: four readers released on one tick at the driver's createFile — red 3/3 at the previous tip, green 3/3 here ([8eb5e45](https://github.com/proteinjs/db/commit/8eb5e456dfb9ac72fc40c1a11c89c6b0a6ae431b))
* **db-file:** the server-side file-data door refuses a caller who may not read the file as unavailable — a 404 ServiceRefusal, not a failure ([dcd631a](https://github.com/proteinjs/db/commit/dcd631a7a6e6d56f3b528a1b930b670d40d9db59))


### Features

* **db-file:** a file read by anyone but its owner is served through the copy the registered FileCopyForOthers makes — made once, stored as the owner's own File and named on the row (copy_for_others, cascade-deleted), dropped when the bytes change; the owner is always served the original; with no maker registered everyone is (the seam for a picture served without its location) ([44edaaa](https://github.com/proteinjs/db/commit/44edaaa3e356eb0c79b56b20e31557bb2654d584))
* **db-file:** a server-side door that made its own access decision is served the owner-or-copy bytes too — FileStorage.getAuthorizedFileData(row) ([927b19e](https://github.com/proteinjs/db/commit/927b19ed3173d80d75f51356d239275198ee1a81))
* **db-file:** a stage variant beside the preview — File.stage, a second derived File with the preview's lifecycle, made through one FileVariantMaker seam ([915cadd](https://github.com/proteinjs/db/commit/915cadd185da162e6b503ca82b23adfc0c55218e))
* **db-file:** File.originModel — which model made the bytes, beside the producer kind ([0005867](https://github.com/proteinjs/db/commit/0005867fc7c98e9e1800c3d86ef81ca64e026547))
* **db-file:** GET /file/:id/variant/:kind — a variant is asked by URL, an existing file derives it on the first request ([c50c32c](https://github.com/proteinjs/db/commit/c50c32cac2037d20623547c39b53c3be489befa9))
* File.origin — producer attribution column (how the bytes came to exist: an upload, a browser capture, a generation, a rendered document), a generic file fact consumers read without a join ([11786b7](https://github.com/proteinjs/db/commit/11786b747bc25a2744cb1c272d3cbb7b819a349c))





## [1.8.4](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.8.3...@proteinjs/db-file@1.8.4) (2026-09-24)

**Note:** Version bump only for package @proteinjs/db-file





## [1.8.3](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.8.2...@proteinjs/db-file@1.8.3) (2026-09-24)

**Note:** Version bump only for package @proteinjs/db-file





## [1.8.2](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.8.1...@proteinjs/db-file@1.8.2) (2026-09-23)

**Note:** Version bump only for package @proteinjs/db-file





## [1.8.1](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.8.0...@proteinjs/db-file@1.8.1) (2026-09-20)

**Note:** Version bump only for package @proteinjs/db-file





# [1.8.0](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.22...@proteinjs/db-file@1.8.0) (2026-09-17)


### Features

* **file:** the rights record on a web-saved copy — licence, licence URL and attribution columns on File ([cf25660](https://github.com/proteinjs/db/commit/cf25660501212b0d78a0a029e03526bce9231c29))





## [1.7.22](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.21...@proteinjs/db-file@1.7.22) (2026-09-16)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.21](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.20...@proteinjs/db-file@1.7.21) (2026-09-14)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.20](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.19...@proteinjs/db-file@1.7.20) (2026-09-13)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.19](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.18...@proteinjs/db-file@1.7.19) (2026-09-13)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.18](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.17...@proteinjs/db-file@1.7.18) (2026-09-12)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.17](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.16...@proteinjs/db-file@1.7.17) (2026-09-05)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.16](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.15...@proteinjs/db-file@1.7.16) (2026-09-03)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.15](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.14...@proteinjs/db-file@1.7.15) (2026-09-03)

**Note:** Version bump only for package @proteinjs/db-file





## [1.7.14](https://github.com/proteinjs/db/compare/@proteinjs/db-file@1.7.13...@proteinjs/db-file@1.7.14) (2026-09-02)

**Note:** Version bump only for package @proteinjs/db-file





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
