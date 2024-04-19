import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getKnexConfig = () => {
  const config = SourceRepository.get().object<KnexConfig>('@proteinjs/db-driver-knex/KnexConfig');
  return Object.assign({
    host: process.env.DB_HOST ? process.env.DB_HOST : 'localhost',
    user: process.env.DB_USER ? process.env.DB_USER : 'root',
    password: process.env.DB_PASSWORD ? process.env.DB_PASSWORD : '',
    dbName: process.env.DB_NAME ? process.env.DB_NAME : 'dev',
  }, config);
}

export type KnexConfig = Loadable & {
  host?: string,
  user?: string,
  password?: string,
  dbName?: string,
}