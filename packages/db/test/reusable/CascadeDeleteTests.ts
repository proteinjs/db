import {
  StringColumn,
  ReferenceColumn,
  ReferenceArrayColumn,
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
  Db,
  DbDriver,
  Table,
  withRecordColumns,
  Record,
  Reference,
  ReferenceArray,
  DefaultTransactionContextFactory,
} from '@proteinjs/db';
import { QueryBuilder } from '@proteinjs/db-query';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import {
  cascadeDeleteTestTables,
  GroupArr,
  GroupDyn,
  GroupRef,
  MemberArr,
  MemberArrRev,
  MemberDyn,
  MemberRef,
  Post,
  Worker,
} from '../util/tables/cascadeDeleteTestTables';

/**
 * Public test suite factory.
 */
export const cascadeDeleteTests = (
  driver: DbDriver,
  transactionContextFactory: DefaultTransactionContextFactory,
  dropTable: (table: Table<any>) => Promise<void>
) => {
  return () => {
    const db = new Db(driver, undefined, transactionContextFactory);
    const testEnv = new DbTestEnvironment(driver, dropTable);

    beforeAll(async () => await testEnv.beforeAll(), 10000);
    afterAll(async () => await testEnv.afterAll(), 10000);

    /**
     * -------------------- Cascade Delete (holder → referenced) --------------------
     */
    describe('Cascade Delete', () => {
      test('ReferenceColumn: deleting holder deletes referenced record', async () => {
        const memberTable = cascadeDeleteTestTables.MemberRef;
        const groupTable = cascadeDeleteTestTables.GroupRef;

        const m = await db.insert(memberTable, { name: 'Alice' });
        const g = await db.insert(groupTable, {
          groupName: 'G-Ref',
          memberRef: new Reference<MemberRef>(memberTable.name, m.id),
        });

        const delQb = new QueryBuilder<GroupRef>(groupTable.name).condition({
          field: 'id',
          operator: '=',
          value: g.id,
        });
        const deleted = await db.delete(groupTable, delQb);
        expect(deleted).toBe(1);

        const remaining = await db.query(memberTable, {});
        expect(remaining.length).toBe(0);
      });

      test('ReferenceArrayColumn: deleting holder deletes all referenced records', async () => {
        const memberTable = cascadeDeleteTestTables.MemberArr;
        const groupTable = cascadeDeleteTestTables.GroupArr;

        const m1 = await db.insert(memberTable, { name: 'Bob' });
        const m2 = await db.insert(memberTable, { name: 'Charlie' });
        const m3 = await db.insert(memberTable, { name: 'Dana' });

        const g = await db.insert(groupTable, {
          groupName: 'G-Arr',
          memberRefs: new ReferenceArray<MemberArr>(memberTable.name, [m1.id, m2.id]),
        });

        const delQb = new QueryBuilder<GroupArr>(groupTable.name).condition({
          field: 'id',
          operator: '=',
          value: g.id,
        });
        const deleted = await db.delete(groupTable, delQb);
        expect(deleted).toBe(1);

        const remaining = await db.query(memberTable, {});
        expect(remaining.length).toBe(1);
        expect(remaining[0].id).toBe(m3.id);
      });

      test('DynamicReferenceColumn: deleting holder deletes dynamically referenced record', async () => {
        const memberTable = cascadeDeleteTestTables.MemberDyn;
        const groupTable = cascadeDeleteTestTables.GroupDyn;

        const m = await db.insert(memberTable, { name: 'Dina' });
        const g = await db.insert(groupTable, {
          groupName: 'G-Dyn',
          memberDynTableName: memberTable.name,
          memberDynRef: new Reference<MemberDyn>(memberTable.name, m.id),
        });

        const delQb = new QueryBuilder<GroupDyn>(groupTable.name).condition({
          field: 'id',
          operator: '=',
          value: g.id,
        });
        const deleted = await db.delete(groupTable, delQb);
        expect(deleted).toBe(1);

        const remaining = await db.query(memberTable, {});
        expect(remaining.length).toBe(0);
      });
    });

    /**
     * -------------------- Reverse Cascade Delete (referenced → holder) --------------------
     */
    describe('Reverse Cascade Delete', () => {
      test('ReferenceColumn: deleting referenced record deletes the holder', async () => {
        const postTable = cascadeDeleteTestTables.Post;
        const commentTable = cascadeDeleteTestTables.Comment;

        const post = await db.insert(postTable, { title: 'Hello World' });
        await db.insert(commentTable, {
          text: 'Nice post!',
          postRef: new Reference<Post>(postTable.name, post.id),
        });

        const delQb = new QueryBuilder<Post>(postTable.name).condition({
          field: 'id',
          operator: '=',
          value: post.id,
        });
        const deleted = await db.delete(postTable, delQb);
        expect(deleted).toBe(1);

        const remaining = await db.query(commentTable, {});
        expect(remaining.length).toBe(0);
      });

      test('ReferenceArrayColumn: deleting a referenced record deletes the holder', async () => {
        const memberTable = cascadeDeleteTestTables.MemberArrRev;
        const groupTable = cascadeDeleteTestTables.GroupArrRev;

        const m1 = await db.insert(memberTable, { name: 'Alice' });
        const m2 = await db.insert(memberTable, { name: 'Bob' });

        await db.insert(groupTable, {
          groupName: 'G-RevArr',
          memberRefs: new ReferenceArray<MemberArrRev>(memberTable.name, [m1.id, m2.id]),
        });

        const delQb = new QueryBuilder<MemberArrRev>(memberTable.name).condition({
          field: 'id',
          operator: '=',
          value: m1.id,
        });
        const deleted = await db.delete(memberTable, delQb);
        expect(deleted).toBe(1);

        const remainingGroups = await db.query(groupTable, {});
        expect(remainingGroups.length).toBe(0);
      });

      test('DynamicReferenceColumn: deleting referenced record deletes the holder', async () => {
        const workerTable = cascadeDeleteTestTables.Worker;
        const taskTable = cascadeDeleteTestTables.Task;

        const worker = await db.insert(workerTable, { name: 'Wally Worker' });
        await db.insert(taskTable, {
          title: 'Assemble Widget',
          assigneeTableName: workerTable.name,
          assigneeRef: new Reference<Worker>(workerTable.name, worker.id),
        });

        const delQb = new QueryBuilder<Worker>(workerTable.name).condition({
          field: 'id',
          operator: '=',
          value: worker.id,
        });
        const deleted = await db.delete(workerTable, delQb);
        expect(deleted).toBe(1);

        const remainingTasks = await db.query(taskTable, {});
        expect(remainingTasks.length).toBe(0);
      });
    });
  };
};
