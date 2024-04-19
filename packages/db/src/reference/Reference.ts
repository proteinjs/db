import { CustomSerializableObject } from '@proteinjs/serializer';
import { getDb } from '../Db';
import { Record } from '../Record';
import { tableByName } from '../Table';
import { ReferenceSerializerId } from '../serializers/ReferenceSerializer';

/**
 * The object returned by Db functions for each field of type ReferenceColumn in a record.
 * The reason for this is to make loading of reference records on-demand. For theoretically 
 * infinitely-nested references, this is necessary. For everything else, this is optimal.
 * 
 * Note: updating the reference via set does not automatically persist those changes in the db.
 * You still need to call Db.update on the record as you would when changing any other field on the record.
 * 
 * Note: all instance members are internal state, made public for ReferenceArraySerializer.
 * Only get() and set() should be used.
 */
export class Reference<T extends Record> implements CustomSerializableObject {
  public __serializerId = ReferenceSerializerId;

  constructor(
    public _table: string,
    public _id?: string,
    public _object?: T,
  ) {}

  static fromObject<T extends Record>(table: string, object: T|(Partial<T> & { id: string })) {
    return new Reference<T>(table, object.id, object as T);
  }

  async get(): Promise<T|undefined> {
    if (!this._object && this._id) {
      const table = tableByName(this._table);
      const db = getDb();
      this._object = await db.get(table, { id: this._id });
    }

    return this._object;
  }

  set(object: T) {
    this._object = object;
    this._id = object.id;
  }
}