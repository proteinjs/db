import { CustomSerializableObject } from '@proteinjs/serializer';
import { getDb } from '../Db';
import { Record } from '../Record';
import { tableByName } from '../Table';
import { ReferenceArraySerializerId } from '../serializers/ReferenceArraySerializer';
import { QueryBuilderFactory } from '../QueryBuilderFactory';
import { Logger } from '@proteinjs/util';
/**
 * The object returned by Db functions for each field of type ReferenceArrayColumn in a record.
 * The reason for this is to make loading of reference records on-demand. For theoretically
 * infinitely-nested references, this is necessary. For everything else, this is optimal.
 *
 * Note: generally only get() needs to be called. Array operations performed on the returned array will be
 * persisted in ReferenceArray.
 *
 * Note: updating items in the returned array does not automatically persist those changes in the db.
 * You still need to call Db.update on the record as you would when changing any other field on the record.
 *
 * Note: all instance members are internal state, made public for ReferenceArraySerializer.
 * Only get() and set() should be used.
 */
export class ReferenceArray<T extends Record> implements CustomSerializableObject {
  public __serializerId = ReferenceArraySerializerId;
  constructor(
    public _table: string,
    public _ids: string[],
    public _objects?: T[]
  ) {}

  static fromObjects<T extends Record>(table: string, objects: (T | (Partial<T> & { id: string }))[]) {
    const ids = objects.map((object) => object.id);
    return new ReferenceArray<T>(table, ids, objects as T[]);
  }

  isLoaded(): boolean {
    return this._objects !== undefined;
  }

  async get(): Promise<T[]> {
    const logger = new Logger('ReferenceArray get');
    if (!this._objects) {
      if (this._ids.length < 1) {
        this._objects = [];
      } else {
        logger.info(`querying db`);
        const table = tableByName(this._table);
        const db = getDb();
        const qb = new QueryBuilderFactory().getQueryBuilder(table);
        qb.condition({ field: 'id', operator: 'IN', value: this._ids });
        qb.sort([{ field: 'id', byValues: this._ids }]);
        this._objects = await db.query(table, qb);
      }
    }

    return this._objects;
  }

  getIfExists(): T[] | undefined {
    if (this._objects) {
      return this._objects;
    }

    return undefined;
  }

  getLength(): number {
    if (this._objects) {
      return this._objects.length;
    }

    return this._ids.length;
  }

  set(objects: T[]) {
    this._objects = objects;
  }
}
