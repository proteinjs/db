import { moment } from '../src/opt/moment';
import { ReferenceArray } from '../src/reference/ReferenceArray';
import { Record } from '../src/Record';
import { ReferenceArraySerializer } from '../src/serializers/ReferenceArraySerializer';

class MockRecord implements Record {
  constructor(
    public id: string,
    public created: moment.Moment,
    public updated: moment.Moment
  ) {}
}

describe('ReferenceArraySerializer', () => {
  const createMockRecord = (id: string) => new MockRecord(id, moment(), moment());

  it('should serialize and deserialize correctly', () => {
    const objects = [createMockRecord('1'), createMockRecord('2')];
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2'], objects);
    const serializer = new ReferenceArraySerializer();

    const serialized = serializer.serialize(refArray);
    expect(serialized).toEqual({
      _table: 'mock_table',
      _ids: ['1', '2'],
      _objects: objects,
    });

    const deserialized = serializer.deserialize(serialized);
    expect(deserialized).toBeInstanceOf(ReferenceArray);
    expect(deserialized._table).toEqual('mock_table');
    expect(deserialized._ids).toEqual(['1', '2']);
    expect(deserialized._objects).toEqual(objects);
  });

  it('should handle empty ReferenceArray', () => {
    const refArray = new ReferenceArray<MockRecord>('mock_table', []);
    const serializer = new ReferenceArraySerializer();

    const serialized = serializer.serialize(refArray);
    expect(serialized).toEqual({
      _table: 'mock_table',
      _ids: [],
      _objects: undefined,
    });

    const deserialized = serializer.deserialize(serialized);
    expect(deserialized).toBeInstanceOf(ReferenceArray);
    expect(deserialized._table).toEqual('mock_table');
    expect(deserialized._ids).toEqual([]);
    expect(deserialized._objects).toBeUndefined();
  });

  it('should handle ReferenceArray with ids but no objects', () => {
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2']);
    const serializer = new ReferenceArraySerializer();

    const serialized = serializer.serialize(refArray);
    expect(serialized).toEqual({
      _table: 'mock_table',
      _ids: ['1', '2'],
      _objects: undefined,
    });

    const deserialized = serializer.deserialize(serialized);
    expect(deserialized).toBeInstanceOf(ReferenceArray);
    expect(deserialized._table).toEqual('mock_table');
    expect(deserialized._ids).toEqual(['1', '2']);
    expect(deserialized._objects).toBeUndefined();
  });

  it('should maintain separate ids and objects after deserialization', () => {
    const objects = [createMockRecord('1'), createMockRecord('2')];
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['3', '4'], objects);
    const serializer = new ReferenceArraySerializer();

    const serialized = serializer.serialize(refArray);
    const deserialized = serializer.deserialize(serialized);

    expect(deserialized._ids).toEqual(['3', '4']);
    expect(deserialized._objects?.map((obj) => obj.id)).toEqual(['1', '2']);
  });
});
