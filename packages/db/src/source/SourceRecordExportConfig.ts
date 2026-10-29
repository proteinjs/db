import { Loadable, SourceRepository } from '@proteinjs/reflection';

/** What the export door needs from the consumer: how this environment names itself. */
export interface SourceRecordExportConfig {
  /**
   * The name of THIS environment as it appears in the header of every declaration exported
   * from it — whatever the consumer calls its deployments (a database name, a stage).
   */
  environment: string;
}

/**
 * Registers the app's `SourceRecordExportConfig`. Implement as a Loadable so the export door
 * finds it; without one, the export refuses — a declaration never leaves an environment it
 * cannot name.
 */
export interface SourceRecordExportConfigFactory extends Loadable {
  getConfig(): SourceRecordExportConfig;
}

export const getSourceRecordExportConfig = (): SourceRecordExportConfig => {
  const factory = SourceRepository.get().object<SourceRecordExportConfigFactory>(
    '@proteinjs/db/SourceRecordExportConfigFactory'
  );
  if (!factory) {
    throw new Error(
      'The export needs the name of this environment: register a SourceRecordExportConfigFactory ' +
        '(@proteinjs/db) that names it'
    );
  }
  const config = factory.getConfig();
  if (!config || typeof config.environment !== 'string' || config.environment.length === 0) {
    throw new Error('SourceRecordExportConfigFactory.getConfig() must name the environment');
  }

  return config;
};
