import { isDuplicateKeyError } from '@proteinjs/db';
import { SettingsService, getSettingsService } from './services/SettingsService';
import { tables } from './tables/tables';
import { getScopedDb } from '@proteinjs/user';

export const getSettings = () => (typeof self === 'undefined' ? new Settings() : (getSettingsService() as Settings));

/**
 * The caller's named settings: one row per name within their scope (`SettingTable`'s unique
 * index), so `get` reads the one row. `set` is ONE write that cannot create a second row: it
 * inserts, and when the index refuses the insert because the row is already there (the typed
 * `DuplicateKeyError`) it updates that one row — the only step after the refusal; the last
 * writer's value is what the row holds. An update-then-insert let two concurrent writers each
 * update nothing and each insert, two rows of one name.
 */
export class Settings implements SettingsService {
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
    try {
      await db.insert(tables.Setting, { name, value });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      await db.update(tables.Setting, { value }, { name });
    }
  }
}
