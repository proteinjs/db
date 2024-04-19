# Test Environment Setup

1. Setup the [Spanner Emulator](https://cloud.google.com/spanner/docs/emulator#linux-macos) on your local machine
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
2. Note: every time you restart the emulator, you need to re-create state (like the instance and the db)