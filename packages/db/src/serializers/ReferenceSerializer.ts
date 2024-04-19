import { CustomSerializer } from '@proteinjs/serializer';
import { Reference } from '../reference/Reference';

type SerializedReference = {
  _table: string,
  _id?: string,
  _object?: any,
}

export const ReferenceSerializerId = '@proteinjs/db/ReferenceSerializer';

export class ReferenceSerializer implements CustomSerializer {
  id = ReferenceSerializerId;
  
  serialize(reference: Reference<any>): SerializedReference {
    return {
      _table: reference._table,
      _id: reference._id,
      _object: reference._object,
    };
  }
  
  deserialize(serializedReference: SerializedReference): Reference<any> {
    return new Reference(serializedReference._table, serializedReference._id, serializedReference._object);
  }
}