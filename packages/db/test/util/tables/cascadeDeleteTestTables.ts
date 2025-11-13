import {
  StringColumn,
  ReferenceColumn,
  ReferenceArrayColumn,
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
  Table,
  withRecordColumns,
  Record,
  Reference,
  ReferenceArray,
} from '@proteinjs/db';

// --- Cascade: ReferenceColumn (GroupRef -> MemberRef)
export interface MemberRef extends Record {
  name: string;
}
export interface GroupRef extends Record {
  groupName: string;
  memberRef?: Reference<MemberRef> | null;
}

// --- Cascade: ReferenceArrayColumn (GroupArr -> MemberArr[])
export interface MemberArr extends Record {
  name: string;
}
export interface GroupArr extends Record {
  groupName: string;
  memberRefs?: ReferenceArray<MemberArr> | null;
}

// --- Cascade: DynamicReferenceColumn (GroupDyn -> MemberDyn)
export interface MemberDyn extends Record {
  name: string;
}
export interface GroupDyn extends Record {
  groupName: string;
  memberDynTableName?: string | null;
  memberDynRef?: Reference<MemberDyn> | null;
}

// --- Reverse: ReferenceColumn (Comment -> Post)
export interface Post extends Record {
  title: string;
}
export interface Comment extends Record {
  text: string;
  postRef?: Reference<Post> | null;
}

// --- Reverse: ReferenceArrayColumn (GroupArrRev -> MemberArrRev[])
export interface MemberArrRev extends Record {
  name: string;
}
export interface GroupArrRev extends Record {
  groupName: string;
  memberRefs?: ReferenceArray<MemberArrRev> | null;
}

// --- Reverse: DynamicReferenceColumn (Task -> Worker)
export interface Worker extends Record {
  name: string;
}
export interface Task extends Record {
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

export const cascadeDeleteTestTables = {
  MemberRef: new MemberRefTable() as Table<MemberRef>,
  GroupRef: new GroupRefTable() as Table<GroupRef>,
  MemberArr: new MemberArrTable() as Table<MemberArr>,
  GroupArr: new GroupArrTable() as Table<GroupArr>,
  MemberDyn: new MemberDynTable() as Table<MemberDyn>,
  GroupDyn: new GroupDynTable() as Table<GroupDyn>,
  Post: new PostTable() as Table<Post>,
  Comment: new CommentTable() as Table<Comment>,
  MemberArrRev: new MemberArrRevTable() as Table<MemberArrRev>,
  GroupArrRev: new GroupArrRevTable() as Table<GroupArrRev>,
  Worker: new WorkerTable() as Table<Worker>,
  Task: new TaskTable() as Table<Task>,
};
