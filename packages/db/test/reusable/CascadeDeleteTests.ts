import {
  Db,
  DbDriver,
  Table,
  Reference,
  ReferenceArray,
  ReferenceColumn,
  StringColumn,
  DefaultTransactionContextFactory,
} from '@proteinjs/db';
import { QueryBuilder } from '@proteinjs/db-query';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import {
  cascadeDeleteTestTables,
  GroupArr,
  GroupDyn,
  GroupRef,
  GuardedHolderArr,
  GuardedHolderDyn,
  GuardedHolderRef,
  GuardedMember,
  MemberArr,
  MemberArrRev,
  MemberDyn,
  MemberRef,
  Pilot,
  Post,
  Robot,
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

    beforeAll(async () => await testEnv.beforeAll(), 120000);
    afterAll(async () => await testEnv.afterAll(), 120000);

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

      test('a delete made for a person is as it was: the holder takes the rows it names, whatever their keeper', async () => {
        // Both tables say whose row it is (`keeper`), and neither has a row rule of its own: this person may
        // delete in both. Whose rows a person may delete is the referenced table's affair, not the option's.
        const memberTable = cascadeDeleteTestTables.MemberArr;
        const groupTable = cascadeDeleteTestTables.GroupArr;
        const own = await db.insert(memberTable, { name: 'Pat', keeper: 'a' });
        const anothers = await db.insert(memberTable, { name: 'Quin', keeper: 'b' });
        const g = await db.insert(groupTable, {
          groupName: 'G-Keepers',
          keeper: 'a',
          memberRefs: new ReferenceArray<MemberArr>(memberTable.name, [own.id, anothers.id]),
        });

        const delQb = new QueryBuilder<GroupArr>(groupTable.name).condition({
          field: 'id',
          operator: '=',
          value: g.id,
        });
        expect(await db.delete(groupTable, delQb)).toBe(1);

        const named = new QueryBuilder<MemberArr>(memberTable.name).condition({
          field: 'id',
          operator: 'IN',
          value: [own.id, anothers.id],
        });
        expect(await db.query(memberTable, named)).toHaveLength(0);
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

      test('DynamicReferenceColumn: edge applies to every target table, scoped per row', async () => {
        const pilotTable = cascadeDeleteTestTables.Pilot;
        const robotTable = cascadeDeleteTestTables.Robot;
        const missionTable = cascadeDeleteTestTables.Mission;

        const pilot = await db.insert(pilotTable, { name: 'Pia Pilot' });
        const robot = await db.insert(robotTable, { name: 'Rusty Robot' });
        const pilotMission = await db.insert(missionTable, {
          title: 'Fly Cargo',
          assigneeTableName: pilotTable.name,
          assigneeRef: new Reference<Pilot>(pilotTable.name, pilot.id),
        });
        await db.insert(missionTable, {
          title: 'Weld Hull',
          assigneeTableName: robotTable.name,
          assigneeRef: new Reference<Robot>(robotTable.name, robot.id),
        });

        // Deleting the robot deletes only the robot-assigned mission; the pilot's survives
        const robotDelQb = new QueryBuilder<Robot>(robotTable.name).condition({
          field: 'id',
          operator: '=',
          value: robot.id,
        });
        const robotsDeleted = await db.delete(robotTable, robotDelQb);
        expect(robotsDeleted).toBe(1);

        const missionsAfterRobot = await db.query(missionTable, {});
        expect(missionsAfterRobot.length).toBe(1);
        expect(missionsAfterRobot[0].id).toBe(pilotMission.id);

        // The same column reverse-cascades off the other target table too
        const pilotDelQb = new QueryBuilder<Pilot>(pilotTable.name).condition({
          field: 'id',
          operator: '=',
          value: pilot.id,
        });
        const pilotsDeleted = await db.delete(pilotTable, pilotDelQb);
        expect(pilotsDeleted).toBe(1);

        const missionsAfterPilot = await db.query(missionTable, {});
        expect(missionsAfterPilot.length).toBe(0);
      });
    });

    /**
     * -------------------- Cascade Delete as system (holder → guarded referenced) --------------------
     * A system delete's cascade runs with the authority of the write that fired it. The children's
     * table refuses every non-system query (a scoped table's shape), and the delete runs in a fresh
     * async context with no session — a background sweep's shape. Before the fix the cascade hooks
     * ran as a non-system Db, and the three cases that open this section failed with the guarded
     * table's refusal.
     */
    describe('Cascade Delete as system', () => {
      const systemDb = new Db(driver, undefined, transactionContextFactory, true);
      const memberTable = cascadeDeleteTestTables.GuardedMember;

      /** A fresh async context with nothing inherited from the test's own — a background sweep's shape. */
      const inFreshContext = <T>(fn: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          setImmediate(() => {
            fn().then(resolve, reject);
          });
        });

      test('ReferenceColumn: a system delete of the holder deletes the guarded referenced record', async () => {
        const holderTable = cascadeDeleteTestTables.GuardedHolderRef;

        const m = await systemDb.insert(memberTable, { name: 'Gail' });
        const h = await systemDb.insert(holderTable, {
          holderName: 'H-Ref',
          memberRef: new Reference<GuardedMember>(memberTable.name, m.id),
        });

        const delQb = new QueryBuilder<GuardedHolderRef>(holderTable.name).condition({
          field: 'id',
          operator: '=',
          value: h.id,
        });
        const deleted = await inFreshContext(() => systemDb.delete(holderTable, delQb));
        expect(deleted).toBe(1);

        expect(await systemDb.query(memberTable, { id: m.id })).toHaveLength(0);
      });

      test('ReferenceArrayColumn: a system delete of the holder deletes every guarded referenced record', async () => {
        const holderTable = cascadeDeleteTestTables.GuardedHolderArr;

        const m1 = await systemDb.insert(memberTable, { name: 'Gus' });
        const m2 = await systemDb.insert(memberTable, { name: 'Greta' });
        const m3 = await systemDb.insert(memberTable, { name: 'Glen' });
        const h = await systemDb.insert(holderTable, {
          holderName: 'H-Arr',
          memberRefs: new ReferenceArray<GuardedMember>(memberTable.name, [m1.id, m2.id]),
        });

        const delQb = new QueryBuilder<GuardedHolderArr>(holderTable.name).condition({
          field: 'id',
          operator: '=',
          value: h.id,
        });
        const deleted = await inFreshContext(() => systemDb.delete(holderTable, delQb));
        expect(deleted).toBe(1);

        expect(await systemDb.query(memberTable, { id: m1.id })).toHaveLength(0);
        expect(await systemDb.query(memberTable, { id: m2.id })).toHaveLength(0);
        // The unreferenced member stands: the cascade is the stored ids, nothing wider.
        expect(await systemDb.query(memberTable, { id: m3.id })).toHaveLength(1);
      });

      test('DynamicReferenceColumn: a system delete of the holder deletes the guarded dynamically referenced record', async () => {
        const holderTable = cascadeDeleteTestTables.GuardedHolderDyn;

        const m = await systemDb.insert(memberTable, { name: 'Gwen' });
        const h = await systemDb.insert(holderTable, {
          holderName: 'H-Dyn',
          memberDynTableName: memberTable.name,
          memberDynRef: new Reference<GuardedMember>(memberTable.name, m.id),
        });

        const delQb = new QueryBuilder<GuardedHolderDyn>(holderTable.name).condition({
          field: 'id',
          operator: '=',
          value: h.id,
        });
        const deleted = await inFreshContext(() => systemDb.delete(holderTable, delQb));
        expect(deleted).toBe(1);

        expect(await systemDb.query(memberTable, { id: m.id })).toHaveLength(0);
      });

      /**
       * A cascade made as the system keeps to the holder's owner. Each of these tables has a column that says
       * whose row it is (`keeper`, `ColumnOptions.owner`): a holder takes with it the rows it names that are
       * its own keeper's, and a row of another keeper that it names stands. A holder that has no keeper takes
       * the rows that have none (the three cases above, and the last one here).
       */
      const deleteAsSystem = (holderTable: Table<any>, ids: string[]) =>
        inFreshContext(() =>
          systemDb.delete(
            holderTable,
            new QueryBuilder<any>(holderTable.name).condition({ field: 'id', operator: 'IN', value: ids })
          )
        );
      const member = (name: string, keeper?: string) =>
        systemDb.insert(memberTable, keeper === undefined ? { name } : { name, keeper });
      const stands = async (row: GuardedMember) => (await systemDb.query(memberTable, { id: row.id })).length === 1;

      test("ReferenceColumn: a system delete of the holder takes the row of its own keeper and leaves another keeper's", async () => {
        const holderTable = cascadeDeleteTestTables.GuardedHolderRef;
        const own = await member('Ada', 'a');
        const anothers = await member('Bo', 'b');
        const holders = [];
        for (const named of [own, anothers]) {
          holders.push(
            await systemDb.insert(holderTable, {
              holderName: 'H-Ref',
              keeper: 'a',
              memberRef: new Reference<GuardedMember>(memberTable.name, named.id),
            })
          );
        }

        expect(
          await deleteAsSystem(
            holderTable,
            holders.map((holder) => holder.id)
          )
        ).toBe(2);
        expect(await stands(own)).toBe(false);
        expect(await stands(anothers)).toBe(true);
      });

      test('ReferenceArrayColumn: a system delete of the holder takes the rows of its own keeper and leaves the rest', async () => {
        const holderTable = cascadeDeleteTestTables.GuardedHolderArr;
        const own = [await member('Ana', 'a'), await member('Abe', 'a')];
        const anothers = await member('Bea', 'b');
        const nobodys = await member('Ned');
        const holder = await systemDb.insert(holderTable, {
          holderName: 'H-Arr',
          keeper: 'a',
          memberRefs: new ReferenceArray<GuardedMember>(memberTable.name, [
            own[0].id,
            anothers.id,
            own[1].id,
            nobodys.id,
          ]),
        });

        expect(await deleteAsSystem(holderTable, [holder.id])).toBe(1);
        expect([await stands(own[0]), await stands(own[1])]).toEqual([false, false]);
        expect([await stands(anothers), await stands(nobodys)]).toEqual([true, true]);
      });

      test("DynamicReferenceColumn: a system delete of the holder takes the row of its own keeper and leaves another keeper's", async () => {
        const holderTable = cascadeDeleteTestTables.GuardedHolderDyn;
        const own = await member('Avi', 'a');
        const anothers = await member('Bao', 'b');
        const holders = [];
        for (const named of [own, anothers]) {
          holders.push(
            await systemDb.insert(holderTable, {
              holderName: 'H-Dyn',
              keeper: 'a',
              memberDynTableName: memberTable.name,
              memberDynRef: new Reference<GuardedMember>(memberTable.name, named.id),
            })
          );
        }

        expect(
          await deleteAsSystem(
            holderTable,
            holders.map((holder) => holder.id)
          )
        ).toBe(2);
        expect(await stands(own)).toBe(false);
        expect(await stands(anothers)).toBe(true);
      });

      test("holders of two keepers deleted together: each takes its own keeper's rows, and neither the other's", async () => {
        const holderTable = cascadeDeleteTestTables.GuardedHolderRef;
        const ofA = [await member('Al', 'a'), await member('Amy', 'a')];
        const ofB = [await member('Ben', 'b'), await member('Bev', 'b')];
        // Each keeper has one holder that names a row of its own, and one that names a row of the other's.
        const naming: [string, GuardedMember][] = [
          ['a', ofA[0]],
          ['a', ofB[0]],
          ['b', ofB[1]],
          ['b', ofA[1]],
        ];
        const holders = [];
        for (const [keeper, named] of naming) {
          holders.push(
            await systemDb.insert(holderTable, {
              holderName: 'H-Two',
              keeper,
              memberRef: new Reference<GuardedMember>(memberTable.name, named.id),
            })
          );
        }

        expect(
          await deleteAsSystem(
            holderTable,
            holders.map((holder) => holder.id)
          )
        ).toBe(4);
        expect([await stands(ofA[0]), await stands(ofB[1])]).toEqual([false, false]);
        expect([await stands(ofB[0]), await stands(ofA[1])]).toEqual([true, true]);
      });

      test("a holder that has no keeper takes the rows that have none, and leaves a keeper's", async () => {
        const holderTable = cascadeDeleteTestTables.GuardedHolderArr;
        const nobodys = await member('Nia');
        const keepers = await member('Kit', 'a');
        const holder = await systemDb.insert(holderTable, {
          holderName: 'H-None',
          memberRefs: new ReferenceArray<GuardedMember>(memberTable.name, [nobodys.id, keepers.id]),
        });

        expect(await deleteAsSystem(holderTable, [holder.id])).toBe(1);
        expect([await stands(nobodys), await stands(keepers)]).toEqual([false, true]);
      });

      test('a table that does not say whose its rows are is cascaded from, and to, as before', async () => {
        // The holder says whose row it is, and the table it names does not.
        const plainMembers = cascadeDeleteTestTables.MemberRef;
        const keptHolders = cascadeDeleteTestTables.GroupRef;
        const plain = await systemDb.insert(plainMembers, { name: 'Uma' });
        const kept = await systemDb.insert(keptHolders, {
          groupName: 'G-Kept',
          keeper: 'a',
          memberRef: new Reference<MemberRef>(plainMembers.name, plain.id),
        });
        expect(await deleteAsSystem(keptHolders, [kept.id])).toBe(1);
        expect(await systemDb.query(plainMembers, { id: plain.id })).toHaveLength(0);

        // The holder does not say, and the table it names does.
        const keptMembers = cascadeDeleteTestTables.MemberArr;
        const plainHolders = cascadeDeleteTestTables.GroupDyn;
        const anothers = await systemDb.insert(keptMembers, { name: 'Vik', keeper: 'b' });
        const holder = await systemDb.insert(plainHolders, {
          groupName: 'G-Plain',
          memberDynTableName: keptMembers.name,
          memberDynRef: new Reference<MemberDyn>(keptMembers.name, anothers.id),
        });
        expect(await deleteAsSystem(plainHolders, [holder.id])).toBe(1);
        expect(await systemDb.query(keptMembers, { id: anothers.id })).toHaveLength(0);
      });

      test('a holder read without its keeper is refused, and nothing is removed', async () => {
        const holderTable = cascadeDeleteTestTables.GuardedHolderRef;
        const kept = await member('Wes', 'a');
        const holder = await systemDb.insert(holderTable, {
          holderName: 'H-Unread',
          keeper: 'a',
          memberRef: new Reference<GuardedMember>(memberTable.name, kept.id),
        });

        const withoutItsKeeper = new QueryBuilder<GuardedHolderRef>(holderTable.name)
          .condition({ field: 'id', operator: '=', value: holder.id })
          .select({ fields: ['id', 'memberRef'] });
        await expect(inFreshContext(() => systemDb.delete(holderTable, withoutItsKeeper))).rejects.toThrow(
          `${holderTable.name}.keeper was not read with the row`
        );
        expect(await systemDb.query(holderTable, { id: holder.id })).toHaveLength(1);
        expect(await stands(kept)).toBe(true);

        // Read whole, the same delete takes both.
        expect(await deleteAsSystem(holderTable, [holder.id])).toBe(1);
        expect(await stands(kept)).toBe(false);
      });

      test('an owner column that is declared amiss is refused when a cascade reads it: two on one table, or one that holds an object', async () => {
        // Declarations alone: no such table is made in the database, and each refusal comes before any read.
        const memberRef = new ReferenceColumn<GuardedMember>('member_id', memberTable.name, true);
        const twoKeepers = {
          name: 'db_test_cd_two_keepers',
          columns: {
            keeper: new StringColumn('keeper_id', { owner: true }),
            other: new StringColumn('other_id', { owner: true }),
            memberRef,
          },
        } as unknown as Table<any>;
        const row = {
          id: 'h',
          keeper: 'a',
          other: 'a',
          memberRef: new Reference<GuardedMember>(memberTable.name, 'm'),
        };

        await expect(
          memberRef.beforeDelete(twoKeepers, 'memberRef', [row], () => memberTable, systemDb)
        ).rejects.toThrow("Table db_test_cd_two_keepers marks more than one column as its rows' owner (keeper, other)");

        const objectKeeper = {
          name: 'db_test_cd_object_keeper',
          columns: { keeper: new StringColumn('keeper_id', { owner: true }), memberRef },
        } as unknown as Table<any>;
        const held = { ...row, keeper: new Reference<GuardedMember>(memberTable.name, 'a') };
        await expect(
          memberRef.beforeDelete(objectKeeper, 'memberRef', [held], () => memberTable, systemDb)
        ).rejects.toThrow('db_test_cd_object_keeper.keeper holds an object');

        // The same for a named row whose owner reads back as an object: refused once it is read, before this
        // cascade's delete. The Db here answers that one row and keeps what it is asked to delete.
        const askedToDelete: unknown[] = [];
        const answering = {
          isSystem: () => true,
          query: async () => [{ id: 'm', keeper: new Reference<GuardedMember>(memberTable.name, 'a') }],
          delete: async (...asked: unknown[]) => {
            askedToDelete.push(asked);
            return 0;
          },
        } as unknown as Db;
        await expect(
          memberRef.beforeDelete(objectKeeper, 'memberRef', [row], () => memberTable, answering)
        ).rejects.toThrow(`${memberTable.name}.keeper holds an object`);
        expect(askedToDelete).toEqual([]);
      });
    });
  };
};
