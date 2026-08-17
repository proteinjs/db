import { Fields, FormButtons } from '@proteinjs/ui';
import { Migration, getDbService, getMigrationRunnerService, tables } from '@proteinjs/db';
import { RecordFormCustomization } from '../RecordFormCustomization';

export class MigrationRecordFormCustomization extends RecordFormCustomization {
  public table = tables.Migration;

  getFormButtons(migration: Migration, defaultFormButtons: FormButtons<any>): FormButtons<any> {
    const formButtons = { ...defaultFormButtons };
    delete formButtons['create'];
    delete formButtons['delete'];
    formButtons['run'] = {
      name: 'Run',
      accessibility: {
        hidden: !migration || migration.status === 'running',
      },
      style: {
        color: 'primary',
        variant: 'contained',
      },
      onClick: async (fields: Fields, buttons: FormButtons<Fields>) => {
        await getMigrationRunnerService().runMigration(migration.id);
        return `Started migration`;
      },
      progressMessage: (fields: Fields) => {
        return `Starting migration`;
      },
    };
    // Retire/Un-retire: the deploy-gated series stamps `retired` on rows whose source class no
    // longer ships, and a retired row is never auto-run again until un-retired here. The Form
    // renders button labels statically, so the toggle is a mutually-exclusive button pair whose
    // visibility flips in place after each write.
    formButtons['retire'] = {
      name: 'Retire',
      accessibility: {
        hidden: !migration || migration.retired === true,
      },
      style: {
        color: 'primary',
        variant: 'text',
      },
      onClick: async (fields: Fields, buttons: FormButtons<Fields>) => {
        await this.setRetired(migration, true, fields, formButtons);
        return `Migration retired — the deploy series will not auto-run it`;
      },
      progressMessage: (fields: Fields) => {
        return `Retiring migration`;
      },
    };
    formButtons['unretire'] = {
      name: 'Un-retire',
      accessibility: {
        hidden: !migration || migration.retired !== true,
      },
      style: {
        color: 'primary',
        variant: 'text',
      },
      onClick: async (fields: Fields, buttons: FormButtons<Fields>) => {
        await this.setRetired(migration, false, fields, formButtons);
        return `Migration un-retired — the deploy series can auto-run it again`;
      },
      progressMessage: (fields: Fields) => {
        return `Un-retiring migration`;
      },
    };
    return formButtons;
  }

  /**
   * Partial write + in-place view reconcile: the flag flips on the row, the loaded record, the
   * rendered field, and the button pair — no whole-record save, no stale intermediate state.
   */
  private async setRetired(migration: Migration, retired: boolean, fields: Fields, formButtons: FormButtons<any>) {
    await getDbService().update(this.table, { id: migration.id, retired } as Partial<Migration>);
    migration.retired = retired;
    if (fields['retired']) {
      fields['retired'].field.value = retired ? 'True' : 'False';
    }
    formButtons['retire'].accessibility = { hidden: retired };
    formButtons['unretire'].accessibility = { hidden: !retired };
  }
}
