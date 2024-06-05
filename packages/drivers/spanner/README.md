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
        projectId: 'n3xa-app',
        instanceName: 'n3xa-prod',
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