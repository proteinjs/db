import { Service, serviceFactory } from '@proteinjs/service';

export const getMigrationRunnerService = serviceFactory<MigrationRunnerService>('@proteinjs/db/MigrationRunnerService');

export interface MigrationRunnerService extends Service {
  runMigration(id: string): Promise<void>;
}