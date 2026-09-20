# Setup

1. [Install Docker](https://docs.docker.com/desktop/install/mac-install/)
2. Create and start mysql container: `docker run -p 127.0.0.1:3306:3306  --name mdb -e MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=TRUE -d mariadb:latest`
3. (optional) Connect to mysql cli: `docker exec -it mdb mariadb --user root`

# What the driver's log lines carry

The driver never prints the value of a parameter bound to a statement. Its failure line (`Failed when executing sql`, at error) carries the SQL text (placeholders only), as `params` a description of each parameter (its position, the kind of its value and, for strings, arrays and bytes, its length), and as `cause` a summary of the failure: the error's name, the vendor's codes (`ER_DUP_ENTRY`, errno, SQLSTATE) and the server's own message. The vendor error itself is no longer on the line: the query layer rewrites a failed query's `message` to the SQL with every binding interpolated, and the client library's error carries the same text as `sql`.

To debug against a local dev database with the real values, set `DB_LOG_PARAM_VALUES=1` in a process that also has `DEVELOPMENT` set: the line then adds `paramValues` (the parameters as bound) and carries the vendor error itself as `error`. With either variable unset the line never carries them. The switch changes the log line only.

What this does NOT cover: the driver throws the vendor's error untouched, exactly as before — so a caller that prints what it catches still prints the interpolated SQL — and the server's own message can echo a bound value (`Duplicate entry '…' for key …`), which the `cause` summary passes on as `sqlMessage`. Closing those is parked on the branch `fix/driver-logs-never-carry-param-values`, pending a decision.
