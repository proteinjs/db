import { moment } from '../src/opt/moment';
import { ReferenceArray } from '../src/reference/ReferenceArray';
import { Record } from '../src/Record';

class MockRecord implements Record {
  constructor(
    public id: string,
    public created: moment.Moment,
    public updated: moment.Moment
  ) {}
}

describe('ReferenceArray', () => {
  const createMockRecord = (id: string) => new MockRecord(id, moment(), moment());

  it('should initialize with correct ids and objects', () => {
    const objects = [createMockRecord('1'), createMockRecord('2')];
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2'], objects);

    expect(refArray._ids).toEqual(['1', '2']);
    expect(refArray._objects).toEqual(objects);
  });

  it('should update ids when objects are modified', async () => {
    const objects = [createMockRecord('1'), createMockRecord('2')];
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2'], objects);

    // Push a new object
    const refArrayObjects = await refArray.get();
    if (refArrayObjects) {
      refArrayObjects.push(createMockRecord('3'));
      expect(refArray._ids).toEqual(['1', '2', '3']);

      // Modify an object
      refArrayObjects[1] = createMockRecord('4');
      expect(refArray._ids).toEqual(['1', '4', '3']);

      // Delete an object using pop
      refArrayObjects.pop();
      expect(refArray._ids).toEqual(['1', '4']);

      // Delete an object using splice
      refArrayObjects.splice(0, 1);
      expect(refArray._ids).toEqual(['4']);
    } else {
      fail('refArrayObjects is undefined');
    }
  });

  it('should update ids when objects are set', () => {
    const objects = [createMockRecord('1'), createMockRecord('2')];
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2'], objects);

    const newObjects = [createMockRecord('5'), createMockRecord('6')];
    refArray.set(newObjects);
    expect(refArray._ids).toEqual(['5', '6']);
    expect(refArray._objects).toEqual(newObjects);
  });

  it('should not leave null or undefined entries in ids array when objects are deleted', () => {
    const objects = [createMockRecord('1'), createMockRecord('2'), createMockRecord('3')];
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2', '3'], objects);

    if (refArray._objects) {
      // Delete the second object using splice
      refArray._objects.splice(1, 1);
      expect(refArray._ids).toEqual(['1', '3']);

      // Delete the first object using splice
      refArray._objects.splice(0, 1);
      expect(refArray._ids).toEqual(['3']);

      // Delete the remaining object
      refArray._objects.pop();
      expect(refArray._ids).toEqual([]);
    } else {
      fail('refArray._objects is undefined');
    }
  });

  it('should handle initializing with an empty array', async () => {
    const refArray = new ReferenceArray<MockRecord>('mock_table', []);

    expect(refArray._ids).toEqual([]);

    const refArrayObjects = await refArray.get();
    expect(refArrayObjects).toEqual([]);

    refArrayObjects.push(createMockRecord('1'));
    expect(refArray._ids).toEqual(['1']);
    expect(refArrayObjects.length).toEqual(1);
  });
});
