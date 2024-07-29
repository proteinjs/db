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

  it('should initialize with correct ids', () => {
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2']);
    expect(refArray._ids).toEqual(['1', '2']);
    expect(refArray._objects).toBeUndefined();
  });

  it('should set and get objects', async () => {
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2']);
    const mockObjects = [createMockRecord('1'), createMockRecord('2')];

    refArray.set(mockObjects);
    const objects = await refArray.get();

    expect(objects).toEqual(mockObjects);
    expect(refArray._objects).toBeDefined();
  });

  it('should set objects without updating ids', () => {
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2']);
    const newObjects = [createMockRecord('3'), createMockRecord('4')];

    refArray.set(newObjects);
    expect(refArray._ids).toEqual(['1', '2']); // ids remain unchanged
    expect(refArray._objects).toEqual(newObjects);
  });

  it('should handle initializing with an empty array', async () => {
    const refArray = new ReferenceArray<MockRecord>('mock_table', []);

    expect(refArray._ids).toEqual([]);
    expect(refArray._objects).toBeUndefined();

    const objects = await refArray.get();
    expect(objects).toEqual([]);
  });

  it('should not update ids when objects are modified', async () => {
    const refArray = new ReferenceArray<MockRecord>('mock_table', ['1', '2']);
    const initialObjects = [createMockRecord('1'), createMockRecord('2')];
    refArray.set(initialObjects);

    const objects = await refArray.get();
    objects.push(createMockRecord('3'));
    objects[1] = createMockRecord('4');
    objects.pop();

    expect(refArray._ids).toEqual(['1', '2']); // ids remain unchanged
  });
});
