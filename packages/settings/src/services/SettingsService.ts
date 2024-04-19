import { Service, serviceFactory } from '@proteinjs/service';

export const getSettingsService = serviceFactory<SettingsService>('@proteinjs/db-settings/SettingsService');

export interface SettingsService extends Service {
  get<T>(name: string, defaultValue?: T): Promise<T>;
  set(name: string, value: any): Promise<void>;
}