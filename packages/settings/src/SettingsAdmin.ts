import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { UserRepo, USER_PERMISSIONS } from '@proteinjs/user';
import { SettingsAdminService, getSettingsAdminService } from './services/SettingsAdminService';
import { Setting } from './tables/SettingTable';
import { tables } from './tables/tables';

export const getSettingsAdmin = () =>
  typeof self === 'undefined' ? new SettingsAdmin() : (getSettingsAdminService() as SettingsAdmin);

/**
 * The ONE path onto another account's settings (`SettingsAdminService`). The scope is the TARGET,
 * pinned here on every read and write through the system db — the `scope` column is write-once for
 * non-system callers, so no other path can seat a row under someone else's account. A write and its
 * `setting_change_event` row commit in one transaction: the trail cannot diverge from the stored
 * settings. The door admits user managers (the `users` permission); the target's own
 * `SettingsService.get` reads what was written — one table, one scope, no second copy.
 */
export class SettingsAdmin implements SettingsAdminService {
  private logger = new Logger({ name: this.constructor.name });
  public serviceMetadata = {
    auth: {
      permission: USER_PERMISSIONS.users,
    },
  };

  async readSettings(userId: string, names: string[]): Promise<{ [name: string]: any }> {
    const target = SettingsAdmin.requireUserId(userId);
    if (names.length === 0) {
      return {};
    }

    const query = new QueryBuilderFactory()
      .createQueryBuilder(tables.Setting)
      .condition({ field: 'scope', operator: '=', value: target })
      .condition({ field: 'name', operator: 'IN', value: names });
    const rows = await getDbAsSystem<Setting>().query(tables.Setting, query);
    const settings: { [name: string]: any } = {};
    for (const row of rows) {
      settings[row.name] = row.value;
    }

    return settings;
  }

  async writeSetting(userId: string, name: string, value: any): Promise<void> {
    const target = SettingsAdmin.requireUserId(userId);
    if (!name) {
      throw new Error(`writeSetting: a setting name is required`);
    }

    const actor = new UserRepo().getUser().id;
    const db = getDbAsSystem<Setting>();
    const existing = await db.get(tables.Setting, { scope: target, name });
    await db.runTransaction(async () => {
      if (existing) {
        await db.update(tables.Setting, { value }, { id: existing.id });
      } else {
        await db.insert(tables.Setting, { scope: target, name, value } as Setting);
      }

      await getDbAsSystem().insert(tables.SettingChangeEvent, {
        actor,
        target,
        name,
        before: existing ? existing.value : null,
        after: value,
      });
    });
    this.logger.info({ message: `Setting written for another account`, obj: { actor, target, name } });
  }

  /** A blank account id is the caller's defect — refused with the reason, never answered empty. */
  private static requireUserId(userId: string): string {
    const id = typeof userId === 'string' ? userId.trim() : '';
    if (!id) {
      throw new Error(`A user id is required — the settings door reads and writes one account's rows`);
    }

    return id;
  }
}
