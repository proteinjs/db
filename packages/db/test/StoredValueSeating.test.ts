import { Column, Table } from '../src/Table';
import {
  DuplicateColumnNameError,
  FieldSerializer,
  MissingFieldError,
  Record,
  RecordSerializer,
  SerializedRecord,
  withRecordColumns,
} from '../src/Record';
import { ArrayColumn, StringColumn } from '../src/Columns';

/**
 * Where a stored cell is seated: by the declared COLUMN name alone. A stored key that is only a
 * PROPERTY's name — the text column `tags` a cutover retired beside the array column `tag_list`
 * that replaced it, property `tags` both times — names no seat: it never reaches the array
 * column's parser, never displaces the array, whichever side of the real cell it lands on, and
 * whatever it holds (a bare word, an empty string, NULL). The row reader used to seat by property
 * name as a second pass, which is the only way an undeclared cell could reach a declared column's
 * parser — and, iterated after the real cell, a NULL in it silently replaced the array.
 */

interface Member extends Record {
  name: string;
  tags: string[] | null;
}

class MemberTable extends Table<Member> {
  public name = 'seating_member';
  public columns = withRecordColumns<Member>({
    name: new StringColumn('name'),
    tags: new ArrayColumn<string>('tag_list'),
  });
}

const memberTable = new MemberTable() as Table<Member>;

type SerializerInternals = { logger: { warn: (...args: unknown[]) => void } };
type SerializerStatics = { legacyCellsWarned: Set<string> };

const LEGACY_WORD = 'legacyword7';

/** Every warning a serializer logs, as the logger received it. */
const warningsOf = (serializer: RecordSerializer<any>): unknown[][] => {
  const calls: unknown[][] = [];
  (serializer as unknown as SerializerInternals).logger.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  return calls;
};

/** A stored row in the given key order — the order a driver's row carries its cells in. */
const rowOf = (cells: { [columnName: string]: unknown }): SerializedRecord => ({
  id: 'm1',
  created: new Date(1_700_000_000_000),
  updated: new Date(1_700_000_000_000),
  ...cells,
});

beforeEach(() => {
  (RecordSerializer as unknown as SerializerStatics).legacyCellsWarned.clear();
});

describe('a stored key that is a property name, not a column name', () => {
  test.each([
    ['a bare word', LEGACY_WORD],
    ['an empty string', ''],
    ['NULL', null],
  ])('iterated AFTER the declared cell, a legacy cell holding %s leaves the array in place', async (_, legacy) => {
    const serializer = new RecordSerializer<Member>(memberTable);
    const warnings = warningsOf(serializer);

    const [record] = await serializer.deserializeAll([rowOf({ name: 'm', tag_list: '["a","b"]', tags: legacy })]);

    expect(record.tags).toEqual(['a', 'b']);
    expect(record).toMatchObject({ id: 'm1', name: 'm' });
    // The legacy cell never reached the array column's parser: no cell-omitted warning.
    expect(warnings).toHaveLength(0);
  });

  test.each([
    ['a bare word', LEGACY_WORD],
    ['an empty string', ''],
    ['NULL', null],
  ])('iterated BEFORE the declared cell, a legacy cell holding %s leaves the array in place', async (_, legacy) => {
    const serializer = new RecordSerializer<Member>(memberTable);
    const warnings = warningsOf(serializer);

    const [record] = await serializer.deserializeAll([rowOf({ name: 'm', tags: legacy, tag_list: '["a","b"]' })]);

    expect(record.tags).toEqual(['a', 'b']);
    expect(warnings).toHaveLength(0);
  });

  test('a stored key equal to a column name is that column; the property name alone is nobody', async () => {
    const fieldSerializer = new FieldSerializer<Member>(memberTable);

    const seated = await fieldSerializer.deserialize('tag_list', '["a"]', {});
    expect(seated).toEqual({ fieldPropertyName: 'tags', fieldValue: ['a'] });

    await expect(fieldSerializer.deserialize('tags', LEGACY_WORD, {})).rejects.toBeInstanceOf(MissingFieldError);
  });
});

describe('two declared columns sharing one stored name', () => {
  test('is refused at the first hydration, naming the table and both properties', () => {
    interface Twice extends Record {
      first: string;
      second: string;
    }
    class TwiceTable extends Table<Twice> {
      public name = 'seating_twice';
      public columns = withRecordColumns<Twice>({
        first: new StringColumn('shared'),
        second: new StringColumn('shared'),
      });
    }
    const serializer = new RecordSerializer<Twice>(new TwiceTable() as Table<Twice>);

    expect(() => serializer.deserializeAll([rowOf({ shared: 'x' })])).toThrow(DuplicateColumnNameError);
    expect(() => serializer.deserializeAll([rowOf({ shared: 'x' })])).toThrow(
      `(seating_twice) Columns first and second both declare the column name 'shared'`
    );
  });
});

describe('the write side', () => {
  class RefusingColumn implements Column<string, string> {
    constructor(public name: string) {}

    async serialize(): Promise<string> {
      throw new RangeError('cannot be stored');
    }
  }
  interface Note extends Record {
    title: string;
    body: string;
  }
  class NoteTable extends Table<Note> {
    public name = 'seating_note';
    public columns = withRecordColumns<Note>({
      title: new StringColumn('title'),
      body: new RefusingColumn('body'),
    });
  }
  const noteTable = new NoteTable() as Table<Note>;

  test('a column that cannot serialize its value fails the write with that error', async () => {
    const serializer = new RecordSerializer<Note>(noteTable);
    const warnings = warningsOf(serializer);

    await expect(serializer.serialize({ id: 'n1', title: 't', body: 'b' })).rejects.toThrow(
      new RangeError('cannot be stored')
    );
    expect(warnings).toHaveLength(0);
  });

  test('a field no column owns is omitted from the write, and warned', async () => {
    const serializer = new RecordSerializer<Member>(memberTable);
    const warnings = warningsOf(serializer);

    const serialized = await serializer.serialize({ id: 'm1', name: 'm', tags: ['a'], retired: 'gone' });

    expect(Object.keys(serialized)).toEqual(['id', 'name', 'tag_list']);
    expect(JSON.parse(serialized.tag_list)).toEqual(['a']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toMatchObject({ obj: { omittedFields: ['retired'] } });
  });
});
