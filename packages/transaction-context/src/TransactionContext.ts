import { DefaultTransactionContextFactory, TransactionContextData } from '@proteinjs/db';
import { AsyncLocalStorage } from 'async_hooks';

export class TransactionContext implements DefaultTransactionContextFactory {
  private static readonly storage = new AsyncLocalStorage<TransactionContextData>();

  getTransactionContext(): TransactionContextData {
    const context = TransactionContext.storage.getStore() || { currentTransaction: undefined };
    return context;
  }

  runInContext<T>(transaction: any, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      TransactionContext.storage.run({ currentTransaction: transaction }, async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
