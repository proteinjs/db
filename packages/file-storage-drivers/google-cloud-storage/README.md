# Setup

1. Create a new storage bucket in Google Cloud Storage
2. Associate a Service Account with the bucket
3. Create a new access key for the Service Account, or use a previously downloaded key if you have one, in Google Cloud Service Accounts. This is found in the IAM & Admin section of Google Cloud. Creating a new key will automatically download the file.
4. Once the key is downloaded, navigate to the file location in your terminal to encode it. `cat your-key-abcde123456.json | base64` Keep the string that is returned to save as an environment variable on your machine.
5. Edit your environment variables. For example: 
  - `nano ~/.zshrc`
  - Add this line `export GCP_GCS_SA_KEY="paste the long string, that you copied from the previous step, here"`
6. Reload your current terminal session to apply the environment variable changes `source ~/.zshrc`
7. Implement a `FileStorageDriverFactory` to provide your GCS config as the default driver for the `FileStorage` api. Alternatively, you can pass the driver into `FileStorage` directly without the following convenience factory.

```typescript
import { DefaultFileStorageDriverFactory, FileStorageDriver } from '@proteinjs/db-file';
import { GoogleCloudStorageDriver } from '@proteinjs/db-file-storage-driver-gcs';

export class FileStorageDriverFactory implements DefaultFileStorageDriverFactory {
  getDriver(): FileStorageDriver {
    const encodedCredentials = process.env.GCP_GCS_SA_KEY;
    if (!encodedCredentials) {
      throw new Error(
        'Unable to instantiate GoogleCloudStorageDriver. The GCP_GCS_SA_KEY environment variable is not set.'
      );
    }

    const credentials = JSON.parse(Buffer.from(encodedCredentials, 'base64').toString('utf-8'));
    return new GoogleCloudStorageDriver({
      projectId: 'your-project-id',
      bucketName: 'your-bucket-name',
      storageOptions: {
        credentials,
      },
    });
  }
}
```
