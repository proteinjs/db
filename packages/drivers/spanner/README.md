# Test Environment Setup

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
4. Note: every time you restart the emulator, you need to re-create state (like the instance and the db). Continue reading if you want to set up a database in Google Cloud Spanner to retain your state.

## Set up Google Cloud Spanner DB
1. In Google Cloud Spanner dashboard, create a new database, one per developer to avoid affecting each other's data.
2. Create a new key, or use a previously downloaded key if you have one, in Google Cloud Service Accounts. This is found in the IAM & Admin section of Google Cloud. Creating a new key will automatically download the file.
4. Once the key is downloaded, navigate to the file location in your terminal to encode it.
`cat your-app-abcde123456.json | base64`
Keep the string that is returned to save as an environment variable on your machine.
5. Edit your environment variables. On Mac for example:
`nano ~/.zshrc`
Add these two lines:
`export DEV_DB_NAME="name-of-your-dev-db"`
`export GCP_SPANNER_SA_KEY="paste the long string that you retrieved from encoding here"`
6. You can then utilize this information when implementing a spanner driver like this.
```
if (process.env.DEVELOPMENT) {
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
        projectId: 'your-project-name',
        instanceName: 'your-instance-name',
        databaseName: devDbName,
        spannerOptions: {
          credentials,
        },
      });
    }
```