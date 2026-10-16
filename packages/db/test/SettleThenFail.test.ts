import { Column, Table } from '../src/Table';
import { Record, RecordSerializer, SerializedRecord, withRecordColumns } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { EncryptionRecordHooks } from '../src/encryption/EncryptionRecordHooks';
import { EncryptionEnvelope } from '../src/encryption/EncryptionEnvelope';
import { DataKeyStore, DataKeyMaterial } from '../src/encryption/DataKeyStore';

/**
 * Settle, then fail. The set reader hydrates rows in order and hands them to ONE promise after the
 * loop; a row that needs an await (a ciphertext envelope whose key is read asynchronously) is a
 * promise in the set from the moment its hook answers. If a LATER row then throws synchronously,
 * the loop ends before that one promise exists — and the earlier row's promise is observed by
 * nobody: its rejection is an `unhandledRejection`, which no caller can catch and a fatal boundary
 * turns into an exit. The law: a synchronous throw fails the set only after every promise the set
 * already created has settled — one rejection, carrying the throw, and no unhandled rejection. The
 * same inside one row, for its cells.
 */

interface Doc extends Record {
  title: string;
  later: number;
  after: string;
}

/** A column whose `deserialize` answers with a promise: resolves the number, rejects for -1. */
class LaterColumn implements Column<number, number> {
  constructor(public name: string) {}

  deserialize(storedValue: number | null): Promise<number | null> {
    return storedValue === -1 ? Promise.reject(new RangeError('unreadable')) : Promise.resolve(storedValue);
  }
}

class DocTable extends Table<Doc> {
  public name = 'settle_doc';
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    later: new LaterColumn('later'),
    after: new StringColumn('after'),
  });
}

const docTable = new DocTable() as Table<Doc>;

const keyFor = (owner: string, version: number): DataKeyMaterial => ({
  owner,
  version,
  cipherKey: Buffer.alloc(32, 7),
  indexKey: Buffer.alloc(32, 9),
});

const storedRow = (id: string, cells: Partial<SerializedRecord> = {}): SerializedRecord => ({
  id,
  created: new Date(1_700_000_000_000),
  updated: new Date(1_700_000_000_000),
  title: `title ${id}`,
  later: 1,
  after: `after ${id}`,
  ...cells,
});

/** The unhandled rejections Node reported while `run` ran, counted after the loop drained twice. */
const unhandledRejectionsDuring = async (
  run: () => Promise<unknown>
): Promise<{ unhandled: number; outcome: unknown }> => {
  let unhandled = 0;
  const listener = () => {
    unhandled++;
  };
  process.on('unhandledRejection', listener);
  try {
    const outcome = await run().then(
      (value) => ({ resolved: value }),
      (error) => ({ rejected: error })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { unhandled, outcome };
  } finally {
    process.off('unhandledRejection', listener);
  }
};

describe('settle, then fail', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('an envelope row whose key read rejects, beside a later row that throws synchronously: one rejection, nothing unhandled', async () => {
    const key = keyFor('owner-1', 4);
    jest.spyOn(DataKeyStore.prototype, 'getKeyByVersion').mockRejectedValue(new Error('key unavailable'));
    const onDeserialize = EncryptionRecordHooks.prototype.onDeserialize;
    jest.spyOn(EncryptionRecordHooks.prototype, 'onDeserialize').mockImplementation(function (
      this: EncryptionRecordHooks,
      table,
      row
    ) {
      if (row.id === 'r2') {
        throw new Error('hook failed');
      }
      return onDeserialize.call(this, table, row);
    });
    const rows = [
      storedRow('r1', { title: new EncryptionEnvelope().encrypt('secret', key) }),
      storedRow('r2'),
      storedRow('r3'),
    ];

    const { unhandled, outcome } = await unhandledRejectionsDuring(async () =>
      new RecordSerializer<Doc>(docTable).deserializeAll(rows)
    );

    expect(outcome).toEqual({ rejected: new Error('hook failed') });
    expect(unhandled).toBe(0);
  });

  test('inside one row: a cell whose promise rejects, beside a later cell that throws synchronously', async () => {
    // A stored value whose `then` getter throws — the one synchronous throw the duck-typed
    // promise check can meet after a column has answered.
    const throwingThenable = {
      get then(): never {
        throw new Error('not a promise after all');
      },
    };
    class ThenableColumn implements Column<unknown, unknown> {
      constructor(public name: string) {}

      deserialize(): unknown {
        return throwingThenable;
      }
    }
    interface Cells extends Record {
      later: number;
      odd: unknown;
    }
    class CellsTable extends Table<Cells> {
      public name = 'settle_cells';
      public columns = withRecordColumns<Cells>({
        later: new LaterColumn('later'),
        odd: new ThenableColumn('odd'),
      });
    }
    const rows = [storedRow('c1', { later: -1, odd: 'x' })];

    const { unhandled, outcome } = await unhandledRejectionsDuring(async () =>
      new RecordSerializer<Cells>(new CellsTable() as Table<Cells>).deserializeAll(rows)
    );

    expect(outcome).toEqual({ rejected: new Error('not a promise after all') });
    expect(unhandled).toBe(0);
  });

  test('a set that mixes the async road with a rejecting cell and a synchronous cell resolves, every row served', async () => {
    const rows = [storedRow('r1'), storedRow('r2', { later: -1 }), storedRow('r3', { later: 3 })];

    const { unhandled, outcome } = await unhandledRejectionsDuring(async () =>
      new RecordSerializer<Doc>(docTable).deserializeAll(rows)
    );

    expect(unhandled).toBe(0);
    const records = (outcome as { resolved: Doc[] }).resolved;
    expect(records.map((record) => record.id)).toEqual(['r1', 'r2', 'r3']);
    expect(records[0].later).toBe(1);
    expect(records[1]).not.toHaveProperty('later');
    expect(records[2].later).toBe(3);
  });
});
