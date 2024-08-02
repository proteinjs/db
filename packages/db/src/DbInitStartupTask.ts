import { StartupTask } from '@proteinjs/server-api';
import { Db } from './Db';

export class DbInitStartupTask implements StartupTask {
  name = 'Initialize db';
  when: StartupTask['when'] = 'before server config';
  async run() {
    await new Db().init();
  }
}
