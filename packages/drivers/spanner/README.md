# Dev Environment Setup

Follow these steps to setup a development Spanner database for your app.

1. In Google Cloud Spanner dashboard, create a new database, one per developer to avoid affecting each other's data. Note: you can alternatively run the Spanner Emulator locally in Docker (described below in the Test Environment Setup); however every time the container is restarted the data will be wiped.
2. Create a new access key, or use a previously downloaded key if you have one, in Google Cloud Service Accounts. This is found in the IAM & Admin section of Google Cloud. Creating a new key will automatically download the file.
3. Once the key is downloaded, navigate to the file location in your terminal to encode it.
`cat your-app-abcde123456.json | base64`
Keep the string that is returned to save as an environment variable on your machine.
4. Edit your environment variables. On Mac for example:
`nano ~/.zshrc`
Add these two lines:
`export DEV_DB_NAME="name-of-your-dev-db"`
`export GCP_SPANNER_SA_KEY="paste the long string that you retrieved from encoding here"`
5. You can then utilize this information when implementing a spanner driver like this. Note: `DefaultDbDriverFactory` is a convenience api for setting the default driver instantiated within Protein Js' `Db`. You do not need to explicitly register `DbDriverFactory` anywhere; the Protein Js dependency injection system [Reflection](https://github.com/proteinjs/reflection) handles that automatically. Alternatively, you can instantiate `Db` with a `SpannerDriver` manually.
```
import { DbDriver, DefaultDbDriverFactory } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';

export class DbDriverFactory implements DefaultDbDriverFactory {
  getDbDriver(): DbDriver {
    const devDbName = process.env.DEV_DB_NAME;
    if (!devDbName) {
      throw new Error('Unable to instantiate SpannerDriver. The DEV_DB_NAME environment variable is not set.');
    }

    const encodedCredentials = process.env.GCP_SPANNER_SA_KEY;
    if (!encodedCredentials) {
      throw new Error('Unable to instantiate SpannerDriver. The GCP_SPANNER_SA_KEY environment variable is not set.');
    }

    const credentials = JSON.parse(Buffer.from(encodedCredentials, 'base64').toString('utf-8'));
    return new SpannerDriver({
      projectId: 'your-project-id',
      instanceName: 'your-instance-name',
      databaseName: devDbName,
      spannerOptions: {
        credentials,
      },
    });
  }
}
```


# Test Environment Setup

Follow these steps to setup a test Spanner Database to be used with running automated tests for code that interacts with a Spanner database.

1. [Install Docker](https://docs.docker.com/desktop/install/mac-install/)
2. [Install gcloud cli](https://cloud.google.com/sdk/docs/install)
3. Setup the [Spanner Emulator](https://cloud.google.com/spanner/docs/emulator#linux-macos) on your local machine
   - Setup emulator in Docker
     ```
     docker pull gcr.io/cloud-spanner-emulator/emulator
     docker run -p 9010:9010 -p 9020:9020 gcr.io/cloud-spanner-emulator/emulator
     ```
   - Create gcloud config to use when connecting to the emulator
     ```
     gcloud config configurations create emulator
     gcloud config set auth/disable_credentials true
     gcloud config set project proteinjs-test
     gcloud config set api_endpoint_overrides/spanner http://localhost:9020/
     ```
     - Note: to switch between configs `gcloud config configurations activate [emulator | default]`
   - Create instance
     ```
     gcloud spanner instances create proteinjs-test \
     --config=emulator-config --description="Protein JS Test Instance" --nodes=1
     ```
   - Create database
     ```
     gcloud spanner databases create test --instance=proteinjs-test
     ```
   - Execute cli query
     ```
       gcloud spanner databases execute-sql test \
         --instance='proteinjs-test' \
         --sql='select table_name from information_schema.tables'
     ```
4. Note: every time you restart the emulator, you need to re-create state (like the instance and the db).
5. Session pool under the emulator: with `SPANNER_EMULATOR_HOST` set and no `sessionPoolOptions` in the driver config, the driver sizes its session pool on demand (`min: 0, incStep: 1`) instead of the client library's eager 25-session fill. Every jest suite constructs a fresh driver, and the fill — not the sessions — is what a loaded emulator pays for, once per suite (the emulator never reaps the sessions a suite leaves behind). Pass `sessionPoolOptions` to override; real Spanner keeps the library defaults.


# Prod Environment Setup

Follow these steps to setup a production Spanner database for your app. This assumes you already implemented Dev Environment Setup above.

1. In Google Cloud Spanner dashboard, create a new database to be used as your prod database.
2. Create a prod sa key
3. Set your prod db name and prod Spanner SA key as secrets in your CI system.
4. Update your `DbDriverFactory` implementation to use different drivers based on environemnt.
```
import { DbDriver, DefaultDbDriverFactory } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';

export class DbDriverFactory implements DefaultDbDriverFactory {
  getDbDriver(): DbDriver {
    if (process.env.DEVELOPMENT) { // or however you check environment
      const devDbName = process.env.DEV_DB_NAME;
      if (!devDbName) {
        throw new Error('Unable to instantiate SpannerDriver. The DEV_DB_NAME environment variable is not set.');
      }

      const encodedCredentials = process.env.GCP_SPANNER_SA_KEY;
      if (!encodedCredentials) {
        throw new Error('Unable to instantiate SpannerDriver. The GCP_SPANNER_SA_KEY environment variable is not set.');
      }

      const credentials = JSON.parse(Buffer.from(encodedCredentials, 'base64').toString('utf-8'));
      return new SpannerDriver({
        projectId: 'your-project-id',
        instanceName: 'your-instance-name',
        databaseName: devDbName,
        spannerOptions: {
          credentials,
        },
      });
    }

    const prodDbName = process.env.PROD_DB_NAME;
    if (!prodDbName) {
      throw new Error('Unable to instantiate SpannerDriver. The PROD_DB_NAME environment variable is not set.');
    }

    const encodedCredentials = process.env.GCP_SPANNER_SA_KEY;
    if (!encodedCredentials) {
      throw new Error('Unable to instantiate SpannerDriver. The GCP_SPANNER_SA_KEY environment variable is not set.');
    }

    const credentials = JSON.parse(Buffer.from(encodedCredentials, 'base64').toString('utf-8'));
    return new SpannerDriver({
      projectId: 'your-project-id',
      instanceName: 'your-instance-name',
      databaseName: prodDbName,
      spannerOptions: {
        credentials,
      },
    });
  }
}
```

# What the driver's log lines carry

The driver never prints the value of a parameter bound to a statement, at any level. Every line it writes about a statement (`Executing query` and `Executing dml` at debug, `Failed when executing …` at error, the retried-abort line at debug) carries the SQL text (placeholders only) and, as `params`, a description of each parameter: its name, its type and, for strings, arrays and bytes, its length.

To debug against an emulator or a local dev database with the real values, set `DB_LOG_PARAM_VALUES=1` in a process that also has `DEVELOPMENT` set: those lines then add `paramValues` (the parameters as bound) beside the description. With either variable unset the lines never carry them. The switch changes log lines only.

Writing a line never changes what the driver throws, or whether a statement runs. The description is built for whatever a statement carries (a parameter that cannot be read is described as `unreadable`), and every statement line is written through one guarded door: if building or writing it fails — a log writer that throws, a value the writer cannot serialize — the driver writes the fixed line `Failed to write a statement log line` instead, which carries nothing of the statement, and goes on exactly as it was going to.

The backend's own error text never rides a line either. The backend quotes the value it choked on, often bare (`Could not parse <value> as a TIMESTAMP`, `Bad int64 value: <value>`, a failed unique-index backfill's `duplicate key: {String("<row value>")}`), and that text stays on what the driver THROWS — the client library decides transaction retries by reading the thrown error's message, so the thrown error is deliberately never rewritten. What changes is what is printed. Every failure that leaves the driver — the typed `SpannerOperationError`, the vendor error under it, a failed commit, rollback or schema update, the transaction runner's budget error, the env-token auth error — is marked with the logger (`LogLineErrors.mark` in `@proteinjs/logger`; `SpannerFailureLine` owns the wording), which never touches the error: any `Logger` line that carries it — the driver's or a caller's; as the line's `error`, inside its `obj`, as another error's `cause` — prints a stand-in made of the gRPC status, the driver's own sentence (`Failed when executing dml (FAILED_PRECONDITION, code 9) on INSERT ledger: the statement cannot run against the database as it stands`) and the original's stack frames. The driver's own lines carry the same under `cause` — `code`, `status` and `message`, the field names a reader of the logs parses; `message` holds the driver's sentence — the schema-update and connectivity lines included (`test/FailureLineShape.test.ts` holds that shape on real lines, and can record them for a reader's own tests). Behind the values switch above a marked error prints as it is, and `cause.message` is the backend's own message. An error the driver words itself (its op deadline) quotes nothing of the backend's and is never marked: a line about it says what the driver said.

What is covered is an error OBJECT that reaches a `Logger`: text copied out of one first (`error.message` in a template, `String(error)`) is a string like any other and prints as it is — log the error itself. The logger reads a line's `obj` within stated bounds (10 levels, 5,000 values, nearest first), so a marked error buried past them in a very large `obj` prints as itself.

What this does NOT cover: text a caller copies out of the error before logging it (`` `failed: ${error.message}` ``, `String(error)`) is a string by the time the logger sees it — pass the error itself.
