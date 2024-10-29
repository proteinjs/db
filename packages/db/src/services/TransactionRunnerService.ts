import { Service, serviceFactory } from '@proteinjs/service';
import { Operation } from '../transaction/Transaction';

export const getTransactionRunnerService = serviceFactory<TransactionRunnerService>(
  '@proteinjs/db/TransactionRunnerService'
);

export interface TransactionRunnerService extends Service {
  run(ops: Operation<any>[]): Promise<void>;
}
