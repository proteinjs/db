/**
 * A DateTime column's moment is built on the field's FIRST READ, not at hydration
 * (`Column.deserializeOnFirstRead`): a row carries many such columns and most are never read, and
 * every moment built at hydration was event-loop time under a large read. What a reader sees is
 * unchanged — an own, enumerable field holding a moment at the stored instant, the same instance on
 * every read, replaceable by a write, present to Object.keys, spread and JSON alike.
 */
jest.mock('moment', () => {
  const actual = jest.requireActual('moment');
  const factory = jest.fn((...args: unknown[]) => actual(...args));
  Object.assign(factory, actual);
  return factory;
});

import '../src/Table';
import moment from 'moment';
import { Table } from '../src/Table';
import { Record, RecordSerializer, SerializedRecord, withRecordColumns } from '../src/Record';
import { DateTimeColumn, StringColumn } from '../src/Columns';

const momentFactory = moment as unknown as jest.Mock;

interface Stamped extends Record {
  title: string;
  t0: moment.Moment | null;
  t1: moment.Moment | null;
  t2: moment.Moment | null;
  t3: moment.Moment | null;
  t4: moment.Moment | null;
  t5: moment.Moment | null;
  t6: moment.Moment | null;
  t7: moment.Moment | null;
  t8: moment.Moment | null;
  t9: moment.Moment | null;
}

class StampedTable extends Table<Stamped> {
  public name = 'stamped';
  public columns = withRecordColumns<Stamped>({
    title: new StringColumn('title'),
    t0: new DateTimeColumn('t0'),
    t1: new DateTimeColumn('t1'),
    t2: new DateTimeColumn('t2'),
    t3: new DateTimeColumn('t3'),
    t4: new DateTimeColumn('t4'),
    t5: new DateTimeColumn('t5'),
    t6: new DateTimeColumn('t6'),
    t7: new DateTimeColumn('t7'),
    t8: new DateTimeColumn('t8'),
    t9: new DateTimeColumn('t9'),
  });
}

const stampedTable = new StampedTable() as Table<Stamped>;

/** What a driver hands the column: a Date (Spanner's is a Date subclass) — the instant is what the column takes. */
const stampsOf = (row: number) => Array.from({ length: 10 }, (_, i) => new Date(1_700_000_000_000 + row * 100 + i));

const storedRows = (count: number): SerializedRecord[] =>
  Array.from({ length: count }, (_, row) => {
    const stamps = stampsOf(row);
    const stored: SerializedRecord = {
      id: `row-${row}`,
      created: new Date(1_600_000_000_000 + row),
      updated: new Date(1_600_000_000_000 + row),
      title: `title ${row}`,
    };
    stamps.forEach((stamp, i) => {
      stored[`t${i}`] = i === 9 ? null : stamp;
    });
    return stored;
  });

/** Through the per-row door; the result-set door shares the hydrator (SyncRowHydration proves its one pass). */
const hydrate = (rows: SerializedRecord[]): Promise<Stamped[]> => {
  const serializer = new RecordSerializer<Stamped>(stampedTable);
  return Promise.all(rows.map((row) => serializer.deserialize(row)));
};

describe('a DateTime field builds its moment on the first read', () => {
  beforeEach(() => {
    momentFactory.mockClear();
  });

  it('hydrating rows with ten DateTime columns builds no moment', async () => {
    const records = await hydrate(storedRows(50));

    expect(records).toHaveLength(50);
    expect(momentFactory).not.toHaveBeenCalled();
  });

  it('the first read builds the moment at the stored instant, once; every read after returns that instance', async () => {
    const [record] = await hydrate(storedRows(1));
    const stamps = stampsOf(0);

    const first = record.t3!;

    expect(moment.isMoment(first)).toBe(true);
    expect(first.valueOf()).toBe(stamps[3].getTime());
    expect(momentFactory).toHaveBeenCalledTimes(1);
    expect(record.t3).toBe(first);
    expect(momentFactory).toHaveBeenCalledTimes(1);
    expect(record.created.valueOf()).toBe(1_600_000_000_000);
    expect(momentFactory).toHaveBeenCalledTimes(2);
  });

  it('a stored null reads null; a write replaces the field', async () => {
    const [record] = await hydrate(storedRows(1));

    expect(record.t9).toBeNull();
    expect(momentFactory).not.toHaveBeenCalled();

    const assigned = moment(0);
    record.t4 = assigned;
    expect(record.t4).toBe(assigned);
    expect(momentFactory).toHaveBeenCalledTimes(1);
  });

  it('the record keeps its shape: own enumerable fields in column order, under spread and JSON alike', async () => {
    const [record] = await hydrate(storedRows(1));
    const stamps = stampsOf(0);

    expect(Object.keys(record)).toEqual([
      'id',
      'created',
      'updated',
      'title',
      't0',
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
      't7',
      't8',
      't9',
    ]);
    expect(Object.prototype.hasOwnProperty.call(record, 't5')).toBe(true);
    expect(momentFactory).not.toHaveBeenCalled();

    const copy = { ...record };
    expect(moment.isMoment(copy.t5)).toBe(true);
    expect(copy.t5).toBe(record.t5);

    const json = JSON.parse(JSON.stringify(record));
    expect(json.t7).toBe(stamps[7].toISOString());
    expect(json.t9).toBeNull();
    expect(json.title).toBe('title 0');
  });

  it('a column read directly still answers the moment itself', () => {
    const column = stampedTable.columns.t0 as DateTimeColumn;
    const stamp = new Date(1_700_000_000_123);

    const value = column.deserialize(stamp);

    expect(moment.isMoment(value)).toBe(true);
    expect(value!.valueOf()).toBe(1_700_000_000_123);
    expect(column.deserialize(null)).toBeNull();
  });
});
