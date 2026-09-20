# Setup

1. [Install Docker](https://docs.docker.com/desktop/install/mac-install/)
2. Create and start mysql container: `docker run -p 127.0.0.1:3306:3306  --name mdb -e MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=TRUE -d mariadb:latest`
3. (optional) Connect to mysql cli: `docker exec -it mdb mariadb --user root`

# What the driver's log lines carry

The driver's failure line (`Failed when executing sql`) never carries a bound parameter's value or the vendor's own error message: it carries the SQL text (placeholders only), a description of each parameter (its position, kind and length) and the vendor's codes (`ER_DUP_ENTRY`, errno, SQLSTATE). The error the driver throws (`KnexOperationError`) says the same and nothing more; the raw vendor error is behind its `vendorError()` method, for a caller that asks for it by name. To debug against a local dev database with the real values, set `DB_LOG_PARAM_VALUES=1` in a process that also has `DEVELOPMENT` set: the failure line then adds `paramValues` (the parameters as bound) and `vendorMessage` (the vendor's message as it arrived). With either variable unset the line never carries them, and the thrown error never does.
