import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getDefaultTransactionContextFactory = () =>
  SourceRepository.get().object<DefaultTransactionContextFactory>('@proteinjs/db/DefaultTransactionContextFactory');

export interface TransactionContextData {
  currentTransaction?: any;
}

export interface DefaultTransactionContextFactory extends Loadable {
  getTransactionContext(): TransactionContextData;
  runInContext<T>(transaction: any, callback: () => Promise<T>): Promise<T>;
}
