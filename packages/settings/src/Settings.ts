import { getDb } from '@proteinjs/db';
import { Logger } from '@proteinjs/util';
import { SettingsService, getSettingsService } from './services/SettingsService';
import { tables } from './tables/tables';
import { getScopedDb } from '@proteinjs/user';

export const getSettings = () => (typeof self === 'undefined' ? new Settings() : (getSettingsService() as Settings));

export class Settings implements SettingsService {
  private logger = new Logger(this.constructor.name);
  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  async get<T>(name: string, defaultValue?: T) {
    const db = getScopedDb();
    const setting = await db.get(tables.Setting, { name });
    if (!setting) {
      return defaultValue;
    }

    return setting.value;
  }

  async set(name: string, value: any) {
    const db = getScopedDb();
    const rowsUpdated = await db.update(tables.Setting, { value }, { name });
    if (rowsUpdated == 0) {
      this.logger.info(`Creating new setting: ${name}`);
      await db.insert(tables.Setting, { name, value });
    }
  }
}
