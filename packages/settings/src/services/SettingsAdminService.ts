import { Service, serviceFactory } from '@proteinjs/service';

export const getSettingsAdminService = serviceFactory<SettingsAdminService>(
  '@proteinjs/db-settings/SettingsAdminService'
);

/**
 * The administrative door onto ANOTHER account's settings. `SettingsService` reads and writes the
 * caller's own rows only (its db is scoped to the session); a user manager acting on someone else's
 * account — a support fix, a preference set on their behalf — needs a door that names the account.
 * Gated on the user-management permission; every write is audited (see `SettingChangeEventTable`).
 */
export interface SettingsAdminService extends Service {
  /**
   * The named settings of `userId`, keyed by name — a name with no stored row is absent from the
   * result (exactly what `SettingsService.get` answers with no default). Never another account's row.
   */
  readSettings(userId: string, names: string[]): Promise<{ [name: string]: any }>;

  /**
   * Store `value` as `userId`'s setting `name` (the whole record — a setting is written as a unit),
   * writing the audit row in the same transaction.
   */
  writeSetting(userId: string, name: string, value: any): Promise<void>;
}
