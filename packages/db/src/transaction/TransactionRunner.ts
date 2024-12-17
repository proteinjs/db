import { getDb } from '../Db';
import { TransactionRunnerService, getTransactionRunnerService } from '../services/TransactionRunnerService';
import { Operation } from './Transaction';

export const getTransactionRunner = () =>
  typeof self === 'undefined' ? new TransactionRunner() : (getTransactionRunnerService() as TransactionRunner);

export class TransactionRunner implements TransactionRunnerService {
  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  async run(ops: Operation<any>[]): Promise<void> {
    const db = getDb();

    await db.runTransaction(async () => {
      for (const op of ops) {
        await (db[op.name] as Function)(...op.args);
      }
    });
  }
}
