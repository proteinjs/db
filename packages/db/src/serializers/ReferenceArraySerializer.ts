import { CustomSerializer } from '@proteinjs/serializer';
import { ReferenceArray } from '../reference/ReferenceArray';

type SerializedReferenceArray = {
  _table: string;
  _ids: string[];
  _objects: any;
};

export const ReferenceArraySerializerId = '@proteinjs/db/ReferenceArraySerializer';

export class ReferenceArraySerializer implements CustomSerializer {
  id = ReferenceArraySerializerId;

  serialize(referenceArray: ReferenceArray<any>): SerializedReferenceArray {
    return {
      _table: referenceArray._table,
      _ids: referenceArray._ids,
      _objects: referenceArray._objects,
    };
  }

  deserialize(serializedReferenceArray: SerializedReferenceArray): ReferenceArray<any> {
    return new ReferenceArray(
      serializedReferenceArray._table,
      serializedReferenceArray._ids,
      serializedReferenceArray._objects
    );
  }
}
