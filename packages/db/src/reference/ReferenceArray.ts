import { CustomSerializableObject } from '@proteinjs/serializer';
import { getDb } from '../Db';
import { Record } from '../Record';
import { tableByName } from '../Table';
import { ReferenceArraySerializerId } from '../serializers/ReferenceArraySerializer';
import { QueryBuilderFactory } from '../QueryBuilderFactory';

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
  ) {
    if (this._objects) {
      this._objects = this.createProxy(this._objects);
    }
  }

  static fromObjects<T extends Record>(table: string, objects: (T | (Partial<T> & { id: string }))[]) {
    const ids = objects.map((object) => object.id);
    return new ReferenceArray<T>(table, ids, objects as T[]);
  }

  /**
   * Used to keep `_ids` in sync with `_objects`
   */
  private createProxy(objects: T[]): T[] {
    const referenceArray = this;
    const handler: ProxyHandler<T[]> = {
      get(target: T[], property: string | symbol, receiver: any) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value === 'function' && ['push', 'pop', 'splice'].includes(property as string)) {
          return function (...args: any[]) {
            const result = (target as any)[property](...args);
            referenceArray._ids = target.map((obj: T) => obj.id);
            return result;
          };
        }
        return value;
      },
      set(target: T[], property: string | symbol, value: any, receiver: any) {
        const result = Reflect.set(target, property, value, receiver);
        if (typeof property === 'number' || !isNaN(Number(property))) {
          referenceArray._ids = target.map((obj: T) => obj.id);
        }
        return result;
      },
      deleteProperty(target: T[], property: string | symbol) {
        if (typeof property === 'number' || !isNaN(Number(property))) {
          target.splice(Number(property), 1);
        }
        referenceArray._ids = target.map((obj: T) => obj.id);
        return true;
      },
    };
    return new Proxy(objects, handler);
  }

  async get(): Promise<T[]> {
    if (!this._objects) {
      if (this._ids.length < 1) {
        this._objects = this.createProxy([]);
      } else {
        const table = tableByName(this._table);
        const db = getDb();
        const qb = new QueryBuilderFactory().getQueryBuilder(table);
        qb.condition({ field: 'id', operator: 'IN', value: this._ids });
        qb.sort([{ field: 'id', byValues: this._ids }]);
        const objects = await db.query(table, qb);
        this._objects = this.createProxy(objects);
      }
    }

    return this._objects;
  }

  set(objects: T[]) {
    this._objects = this.createProxy(objects);
    this._ids = objects.map((object) => object.id);
  }
}
