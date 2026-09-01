/**
 * The expand-phase window of a physical column RENAME (the encryption rollout's
 * `object` JSON → `object_enc` STRING move) leaves the retired column in the database next
 * to its successor. A row read then carries BOTH keys — and the retired key must never be
 * claimed by the same-named PROPERTY (whose declared column is the renamed successor):
 * pre-fix, `FieldSerializer.deserialize`'s property-name shortcut clobbered the decrypted
 * successor value with the retired column's stale bytes (or null), the exact read-corruption
 * shape a production rollout would hit between deploy and the manual column drop.
 */
import { Table } from '../src/Table';
import { Record, RecordSerializer, withRecordColumns } from '../src/Record';
import { ObjectColumn, StringColumn } from '../src/Columns';

interface RenamedRow extends Record {
  object?: any;
  description?: string | null;
}

class RenamedRowTable extends Table<RenamedRow> {
  name = 'renamed_row_test';
  columns: Table<RenamedRow>['columns'] = withRecordColumns<RenamedRow>({
    // The property keeps its name; the physical column moved (the encryption-adoption shape).
    object: new ObjectColumn('object_enc', { encrypted: false }),
    description: new StringColumn('description', { encrypted: false }),
  });
}

describe('deserializing rows that still carry a retired physical column', () => {
  const table = new RenamedRowTable() as Table<RenamedRow>;

  test('the renamed successor value wins; the retired column key is omitted, not claimed by the property', async () => {
    const serializer = new RecordSerializer<RenamedRow>(table);
    const serialized = await serializer.serialize({ object: { content: 'the real value' }, description: 'row' });
    expect(typeof serialized['object_enc']).toBe('string');

    // What a SELECT * returns mid-rollout: the successor AND the retired column (stale/null).
    const row = { ...serialized, object: null } as any;
    const deserialized = await serializer.deserialize(row);
    expect(deserialized.object).toEqual({ content: 'the real value' });

    const rowWithStaleBytes = { ...serialized, object: { content: 'STALE pre-rollout copy' } } as any;
    const deserializedStale = await serializer.deserialize(rowWithStaleBytes);
    expect(deserializedStale.object).toEqual({ content: 'the real value' });
  });
});
