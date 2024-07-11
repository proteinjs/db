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
    expect(deserialized._table).toEqual('mock_table');
    expect(deserialized._ids).toEqual(['1', '2']);
    expect(deserialized._objects).toEqual(objects);

    // Test if the proxy is correctly applied
    if (deserialized._objects) {
      deserialized._objects.push(createMockRecord('3'));
      expect(deserialized._ids).toEqual(['1', '2', '3']);
    } else {
      fail('deserialized._objects is undefined');
    }
  });
});
