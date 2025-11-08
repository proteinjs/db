import {
  StringColumn,
  ReferenceColumn,
  ReferenceArrayColumn,
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
} from '../../src/Columns';
import { Db, DbDriver } from '../../src/Db';
import { Table } from '../../src/Table';
import { withRecordColumns, Record } from '../../src/Record';
import { Reference } from '../../src/reference/Reference';
import { ReferenceArray } from '../../src/reference/ReferenceArray';
import { QueryBuilder } from '@proteinjs/db-query';
import { DefaultTransactionContextFactory } from '../../src/transaction/TransactionContextFactory';

/**
 * ---------- Test Entities ----------
 * (Isolated per scenario so we never mount multiple cascade columns
 *  to the same target on a single table.)
 */

// --- Cascade: ReferenceColumn (GroupRef -> MemberRef)
interface MemberRef extends Record {
  name: string;
}
interface GroupRef extends Record {
  groupName: string;
  memberRef?: Reference<MemberRef> | null;
}

// --- Cascade: ReferenceArrayColumn (GroupArr -> MemberArr[])
interface MemberArr extends Record {
  name: string;
}
interface GroupArr extends Record {
  groupName: string;
  memberRefs?: ReferenceArray<MemberArr> | null;
}

// --- Cascade: DynamicReferenceColumn (GroupDyn -> MemberDyn)
interface MemberDyn extends Record {
  name: string;
}
interface GroupDyn extends Record {
  groupName: string;
  memberDynTableName?: string | null;
  memberDynRef?: Reference<MemberDyn> | null;
}

// --- Reverse: ReferenceColumn (Comment -> Post)
interface Post extends Record {
  title: string;
}
interface Comment extends Record {
  text: string;
  postRef?: Reference<Post> | null;
}

// --- Reverse: ReferenceArrayColumn (GroupArrRev -> MemberArrRev[])
interface MemberArrRev extends Record {
  name: string;
}
interface GroupArrRev extends Record {
  groupName: string;
  memberRefs?: ReferenceArray<MemberArrRev> | null;
}

// --- Reverse: DynamicReferenceColumn (Task -> Worker)
interface Worker extends Record {
  name: string;
}
interface Task extends Record {
  title: string;
  assigneeTableName?: string | null;
  assigneeRef?: Reference<Worker> | null;
}

/**
 * ---------- Table Names ----------
 */
// Cascade (ReferenceColumn)
const MEMBER_REF_TABLE = 'db_test_cd_members_ref';
const GROUP_REF_TABLE = 'db_test_cd_groups_ref';

// Cascade (ReferenceArrayColumn)
const MEMBER_ARR_TABLE = 'db_test_cd_members_arr';
const GROUP_ARR_TABLE = 'db_test_cd_groups_arr';

// Cascade (DynamicReferenceColumn)
const MEMBER_DYN_TABLE = 'db_test_cd_members_dyn';
const GROUP_DYN_TABLE = 'db_test_cd_groups_dyn';

// Reverse (ReferenceColumn)
const POST_TABLE = 'db_test_cd_posts';
const COMMENT_TABLE = 'db_test_cd_comments';

// Reverse (ReferenceArrayColumn)
const MEMBER_ARR_REV_TABLE = 'db_test_cd_members_arr_rev';
const GROUP_ARR_REV_TABLE = 'db_test_cd_groups_arr_rev';

// Reverse (DynamicReferenceColumn)
const WORKER_TABLE = 'db_test_cd_workers';
const TASK_TABLE = 'db_test_cd_tasks';

/**
 * ---------- Table Classes ----------
 */
// Cascade: ReferenceColumn
export class MemberRefTable extends Table<MemberRef> {
  name = MEMBER_REF_TABLE;
  columns = withRecordColumns<MemberRef>({
    name: new StringColumn('name'),
  });
}
export class GroupRefTable extends Table<GroupRef> {
  name = GROUP_REF_TABLE;
  columns = withRecordColumns<GroupRef>({
    groupName: new StringColumn('group_name'),
    memberRef: new ReferenceColumn<MemberRef>(
      'member_id',
      MEMBER_REF_TABLE,
      true // cascade: deleting GroupRef deletes the referenced MemberRef
    ),
  });
}

// Cascade: ReferenceArrayColumn
export class MemberArrTable extends Table<MemberArr> {
  name = MEMBER_ARR_TABLE;
  columns = withRecordColumns<MemberArr>({
    name: new StringColumn('name'),
  });
}
export class GroupArrTable extends Table<GroupArr> {
  name = GROUP_ARR_TABLE;
  columns = withRecordColumns<GroupArr>({
    groupName: new StringColumn('group_name'),
    memberRefs: new ReferenceArrayColumn<MemberArr>(
      'member_ids',
      MEMBER_ARR_TABLE,
      true // cascade: deleting GroupArr deletes all referenced MemberArr
    ),
  });
}

// Cascade: DynamicReferenceColumn
export class MemberDynTable extends Table<MemberDyn> {
  name = MEMBER_DYN_TABLE;
  columns = withRecordColumns<MemberDyn>({
    name: new StringColumn('name'),
  });
}
export class GroupDynTable extends Table<GroupDyn> {
  name = GROUP_DYN_TABLE;
  columns = withRecordColumns<GroupDyn>({
    groupName: new StringColumn('group_name'),
    memberDynTableName: new DynamicReferenceTableNameColumn('member_dyn_table_name', 'member_dyn_ref'),
    memberDynRef: new DynamicReferenceColumn<MemberDyn>(
      'member_dyn_ref',
      'member_dyn_table_name',
      true // cascade: deleting GroupDyn deletes dynamically referenced MemberDyn
    ),
  });
}

// Reverse: ReferenceColumn
export class PostTable extends Table<Post> {
  name = POST_TABLE;
  columns = withRecordColumns<Post>({
    title: new StringColumn('title'),
  });
}
export class CommentTable extends Table<Comment> {
  name = COMMENT_TABLE;
  columns = withRecordColumns<Comment>({
    text: new StringColumn('text'),
    postRef: new ReferenceColumn<Post>(
      'post_id',
      POST_TABLE,
      false,
      { reverseCascadeDelete: true } // reverse: deleting Post deletes Comment
    ),
  });
}

// Reverse: ReferenceArrayColumn
export class MemberArrRevTable extends Table<MemberArrRev> {
  name = MEMBER_ARR_REV_TABLE;
  columns = withRecordColumns<MemberArrRev>({
    name: new StringColumn('name'),
  });
}
export class GroupArrRevTable extends Table<GroupArrRev> {
  name = GROUP_ARR_REV_TABLE;
  columns = withRecordColumns<GroupArrRev>({
    groupName: new StringColumn('group_name'),
    memberRefs: new ReferenceArrayColumn<MemberArrRev>(
      'member_ids',
      MEMBER_ARR_REV_TABLE,
      false,
      { reverseCascadeDelete: true } // reverse: deleting any MemberArrRev deletes the GroupArrRev
    ),
  });
}

// Reverse: DynamicReferenceColumn
export class WorkerTable extends Table<Worker> {
  name = WORKER_TABLE;
  columns = withRecordColumns<Worker>({
    name: new StringColumn('name'),
  });
}
export class TaskTable extends Table<Task> {
  name = TASK_TABLE;
  columns = withRecordColumns<Task>({
    title: new StringColumn('title'),
    assigneeTableName: new DynamicReferenceTableNameColumn('assignee_table_name', 'assignee_ref'),
    assigneeRef: new DynamicReferenceColumn<Worker>(
      'assignee_ref',
      'assignee_table_name',
      false,
      { reverseCascadeDelete: true } // reverse: deleting Worker deletes Task
    ),
  });
}

/** getTable resolver for Db */
export const getCascadeDeleteTestTable = (tableName: string) => {
  switch (tableName) {
    // Cascade
    case MEMBER_REF_TABLE:
      return new MemberRefTable();
    case GROUP_REF_TABLE:
      return new GroupRefTable();
    case MEMBER_ARR_TABLE:
      return new MemberArrTable();
    case GROUP_ARR_TABLE:
      return new GroupArrTable();
    case MEMBER_DYN_TABLE:
      return new MemberDynTable();
    case GROUP_DYN_TABLE:
      return new GroupDynTable();

    // Reverse
    case POST_TABLE:
      return new PostTable();
    case COMMENT_TABLE:
      return new CommentTable();
    case MEMBER_ARR_REV_TABLE:
      return new MemberArrRevTable();
    case GROUP_ARR_REV_TABLE:
      return new GroupArrRevTable();
    case WORKER_TABLE:
      return new WorkerTable();
    case TASK_TABLE:
      return new TaskTable();

    default:
      throw new Error(`Cannot find test table: ${tableName}`);
  }
};

/**
 * Public test suite factory.
 */
export const cascadeDeleteTests = (
  driver: DbDriver,
  transactionContextFactory: DefaultTransactionContextFactory,
  dropTable: (table: Table<any>) => Promise<void>
) => {
  return () => {
    const db = new Db(driver, getCascadeDeleteTestTable, transactionContextFactory);

    beforeAll(async () => {
      if (driver.start) {
        await driver.start();
      }
    });

    beforeEach(async () => {
      // Ensure tables exist and are in a known state for each test
      await driver.getTableManager().loadTable(new MemberRefTable());
      await driver.getTableManager().loadTable(new GroupRefTable());

      await driver.getTableManager().loadTable(new MemberArrTable());
      await driver.getTableManager().loadTable(new GroupArrTable());

      await driver.getTableManager().loadTable(new MemberDynTable());
      await driver.getTableManager().loadTable(new GroupDynTable());

      await driver.getTableManager().loadTable(new PostTable());
      await driver.getTableManager().loadTable(new CommentTable());

      await driver.getTableManager().loadTable(new MemberArrRevTable());
      await driver.getTableManager().loadTable(new GroupArrRevTable());

      await driver.getTableManager().loadTable(new WorkerTable());
      await driver.getTableManager().loadTable(new TaskTable());
    });

    afterEach(async () => {
      // Drop referencing tables first, then referenced
      await dropTable(new GroupRefTable());
      await dropTable(new MemberRefTable());

      await dropTable(new GroupArrTable());
      await dropTable(new MemberArrTable());

      await dropTable(new GroupDynTable());
      await dropTable(new MemberDynTable());

      await dropTable(new CommentTable());
      await dropTable(new PostTable());

      await dropTable(new GroupArrRevTable());
      await dropTable(new MemberArrRevTable());

      await dropTable(new TaskTable());
      await dropTable(new WorkerTable());
    });

    afterAll(async () => {
      if (driver.stop) {
        await driver.stop();
      }
    });

    /**
     * -------------------- Cascade Delete (holder → referenced) --------------------
     */
    describe('Cascade Delete', () => {
      test('ReferenceColumn: deleting holder deletes referenced record', async () => {
        const memberTable = new MemberRefTable();
        const groupTable = new GroupRefTable();

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
        const memberTable = new MemberArrTable();
        const groupTable = new GroupArrTable();

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
        const memberTable = new MemberDynTable();
        const groupTable = new GroupDynTable();

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
        const postTable = new PostTable();
        const commentTable = new CommentTable();

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
        const memberTable = new MemberArrRevTable();
        const groupTable = new GroupArrRevTable();

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
        const workerTable = new WorkerTable();
        const taskTable = new TaskTable();

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
