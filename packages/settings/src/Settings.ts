import { isDuplicateKeyError } from '@proteinjs/db';
import { SettingsService, getSettingsService } from './services/SettingsService';
import { tables } from './tables/tables';
import { getScopedDb } from '@proteinjs/user';

export const getSettings = () => (typeof self === 'undefined' ? new Settings() : (getSettingsService() as Settings));

/**
 * The caller's named settings: one row per name within their scope (`SettingTable`'s unique
 * index), so `get` reads the one row. `set` is one write that cannot mint a second row: it
 * updates the row; when there is none it inserts; and when the index refuses that insert because
 * another writer landed the row in between (the typed `DuplicateKeyError` — the race's only path)
 * it updates the one row — the last writer's value is what the row holds. The update comes first
 * because a rewrite of an existing name is the common act: insert-first made every rewrite a
 * refused statement the driver reports as a failure. Without the index, two concurrent writers
 * each updated nothing and each inserted, two rows of one name.
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
    if ((await db.update(tables.Setting, { value }, { name })) > 0) {
      return;
    }
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
