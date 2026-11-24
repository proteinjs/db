import { Db, DbDriver, QueryBuilderFactory, Reference, ReferenceArray, Table, tableByName } from '@proteinjs/db';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import { registerTestUser } from '../util/testUser';
import { dynamicReferenceTestTables, ProjectAssignment } from '../util/tables/dynamicReferenceColumnTestTables';
import { cascadeDeleteTestTables } from '../util/tables/cascadeDeleteTestTables';

/**
 * Preload behavior tests: `preloadReferences` must hydrate every reference in the result set
 * with ONE query per referenced table — batching is the point of the option (a 30-row window
 * preloaded per-row is 30 serialized point reads). The assertions count driver round trips,
 * the outcome that keeps preload cheap, and then verify hydration is complete (no further
 * round trips to read every referenced object).
 */
export const preloadReferencesTests = (driver: DbDriver, dropTable: (table: Table<any>) => Promise<void>) => {
  return () => {
    // Counting proxy: every runQuery through the driver increments `queryCount`. Db reads
    // nothing else off the driver during query execution that matters here; everything not
    // overridden delegates to the real driver via the prototype chain.
    let queryCount = 0;
    const countingDriver: DbDriver = Object.create(driver, {
      runQuery: {
        value: (...args: unknown[]) => {
          queryCount++;
          return (driver.runQuery as (...a: unknown[]) => Promise<unknown>).apply(driver, args);
        },
      },
    });
    const db = new Db(countingDriver);
    const testEnv = new DbTestEnvironment(driver, dropTable);

    beforeAll(async () => await testEnv.beforeAll(), 120000);
    afterAll(async () => await testEnv.afterAll(), 120000);

    test('preload hydrates dynamic references with one query per referenced table', async () => {
      const engineerA = await db.insert(dynamicReferenceTestTables.Engineer, {
        name: 'preload-batch engineer A',
        yearsOfExperience: 3,
      });
      const engineerB = await db.insert(dynamicReferenceTestTables.Engineer, {
        name: 'preload-batch engineer B',
        yearsOfExperience: 7,
      });
      const designer = await db.insert(dynamicReferenceTestTables.Designer, {
        name: 'preload-batch designer',
        specialization: 'Motion',
      });
      const employees = [engineerA, engineerB, designer];
      const employeeTables = [
        dynamicReferenceTestTables.Engineer.name,
        dynamicReferenceTestTables.Engineer.name,
        dynamicReferenceTestTables.Designer.name,
      ];
      for (let i = 0; i < employees.length; i++) {
        await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
          projectName: `preload-batch project ${i}`,
          employeeRef: new Reference(employeeTables[i], employees[i].id),
          startDate: '2026-01-01',
        });
      }

      const qb = new QueryBuilderFactory()
        .getQueryBuilder(dynamicReferenceTestTables.ProjectAssignment)
        .condition({ field: 'projectName', operator: 'LIKE', value: 'preload-batch project %' });
      queryCount = 0;
      const assignments = await db.query(dynamicReferenceTestTables.ProjectAssignment, qb, {
        preloadReferences: { enabled: true, includeColumns: ['employeeRef'] },
      });
      const queriesDuringPreload = queryCount;

      expect(assignments.length).toBe(3);
      // Hydration must be complete: every referenced object readable with ZERO further round trips.
      queryCount = 0;
      const names = (await Promise.all(assignments.map((assignment) => assignment.employeeRef!.get())))
        .map((employee) => employee!.name)
        .sort();
      expect(names).toEqual(['preload-batch designer', 'preload-batch engineer A', 'preload-batch engineer B']);
      expect(queryCount).toBe(0);
      // One round trip for the assignments window, then one per referenced table
      // (engineers, designers) — never one per row.
      expect(queriesDuringPreload).toBe(3);
    });

    test('preload hydrates reference arrays with one query per referenced table', async () => {
      const memberIds: string[][] = [];
      for (let g = 0; g < 2; g++) {
        const ids: string[] = [];
        for (let m = 0; m < 2; m++) {
          const member = await db.insert(cascadeDeleteTestTables.MemberArr, {
            name: `preload-arr member ${g}.${m}`,
          });
          ids.push(member.id);
        }
        memberIds.push(ids);
      }
      for (let g = 0; g < 2; g++) {
        await db.insert(cascadeDeleteTestTables.GroupArr, {
          groupName: `preload-arr group ${g}`,
          memberRefs: new ReferenceArray(cascadeDeleteTestTables.MemberArr.name, memberIds[g]),
        });
      }

      const qb = new QueryBuilderFactory()
        .getQueryBuilder(cascadeDeleteTestTables.GroupArr)
        .condition({ field: 'groupName', operator: 'LIKE', value: 'preload-arr group %' })
        .sort([{ field: 'groupName', desc: false }]);
      queryCount = 0;
      const groups = await db.query(cascadeDeleteTestTables.GroupArr, qb, {
        preloadReferences: { enabled: true },
      });
      const queriesDuringPreload = queryCount;

      expect(groups.length).toBe(2);
      // Hydration must be complete AND ordered per each array's _ids, with zero further round trips.
      queryCount = 0;
      for (let g = 0; g < 2; g++) {
        const members = await groups[g].memberRefs!.get();
        expect(members.map((member) => member.name)).toEqual([
          `preload-arr member ${g}.0`,
          `preload-arr member ${g}.1`,
        ]);
      }
      expect(queryCount).toBe(0);
      // One round trip for the groups, one for ALL members across both arrays.
      expect(queriesDuringPreload).toBe(2);
    });

    test("a referenced table the asker's `admits` does not admit is left unloaded; the rest load as before", async () => {
      const engineerA = await db.insert(dynamicReferenceTestTables.Engineer, {
        name: 'preload-admits engineer A',
        yearsOfExperience: 4,
      });
      const engineerB = await db.insert(dynamicReferenceTestTables.Engineer, {
        name: 'preload-admits engineer B',
        yearsOfExperience: 9,
      });
      const designer = await db.insert(dynamicReferenceTestTables.Designer, {
        name: 'preload-admits designer',
        specialization: 'Type',
      });
      const employees = [engineerA, engineerB, designer];
      const employeeTables = [
        dynamicReferenceTestTables.Engineer.name,
        dynamicReferenceTestTables.Engineer.name,
        dynamicReferenceTestTables.Designer.name,
      ];
      for (let i = 0; i < employees.length; i++) {
        await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
          projectName: `preload-admits project ${i}`,
          employeeRef: new Reference(employeeTables[i], employees[i].id),
          startDate: '2026-01-01',
        });
      }

      const askedAbout: string[] = [];
      const qb = new QueryBuilderFactory()
        .getQueryBuilder(dynamicReferenceTestTables.ProjectAssignment)
        .condition({ field: 'projectName', operator: 'LIKE', value: 'preload-admits project %' })
        .sort([{ field: 'projectName', desc: false }]);
      queryCount = 0;
      const assignments = await db.query(dynamicReferenceTestTables.ProjectAssignment, qb, {
        preloadReferences: {
          enabled: true,
          includeColumns: ['employeeRef'],
          admits: (tableName) => {
            askedAbout.push(tableName);
            return tableName !== dynamicReferenceTestTables.Designer.name;
          },
        },
      });
      // One round trip for the assignments and one for the engineers; none for the designers.
      expect(queryCount).toBe(2);
      expect(assignments.map((assignment) => assignment.employeeRef!._object?.name)).toEqual([
        'preload-admits engineer A',
        'preload-admits engineer B',
        undefined,
      ]);
      // The reference left unloaded still says which row it names, for its reader to ask for.
      expect(assignments[2].employeeRef!._table).toBe(dynamicReferenceTestTables.Designer.name);
      expect(assignments[2].employeeRef!._id).toBe(designer.id);
      // Each referenced table is asked about once, however many rows name it.
      expect(askedAbout.sort()).toEqual(
        [dynamicReferenceTestTables.Designer.name, dynamicReferenceTestTables.Engineer.name].sort()
      );

      const member = await db.insert(cascadeDeleteTestTables.MemberArr, { name: 'preload-admits member' });
      await db.insert(cascadeDeleteTestTables.GroupArr, {
        groupName: 'preload-admits group',
        memberRefs: new ReferenceArray(cascadeDeleteTestTables.MemberArr.name, [member.id]),
      });
      queryCount = 0;
      const groups = await db.query(
        cascadeDeleteTestTables.GroupArr,
        { groupName: 'preload-admits group' },
        { preloadReferences: { enabled: true, admits: () => false } }
      );
      // One round trip for the group; none for its members.
      expect(queryCount).toBe(1);
      expect(groups.length).toBe(1);
      expect(groups[0].memberRefs!._ids).toEqual([member.id]);
      expect(groups[0].memberRefs!._objects).toBeUndefined();

      // A list that names nothing has nothing to load: it is filled as before, and its table is not asked about.
      await db.insert(cascadeDeleteTestTables.GroupArr, {
        groupName: 'preload-admits empty group',
        memberRefs: new ReferenceArray(cascadeDeleteTestTables.MemberArr.name, []),
      });
      const askedOfAnEmptyList: string[] = [];
      const empty = await db.query(
        cascadeDeleteTestTables.GroupArr,
        { groupName: 'preload-admits empty group' },
        {
          preloadReferences: {
            enabled: true,
            admits: (tableName) => {
              askedOfAnEmptyList.push(tableName);
              return false;
            },
          },
        }
      );
      expect(empty[0].memberRefs!._objects).toEqual([]);
      expect(askedOfAnEmptyList).toEqual([]);
    });

    test('a read through the table service loads a reference only from a table whose own service door admits the caller', async () => {
      const engineer = await db.insert(dynamicReferenceTestTables.Engineer, {
        name: 'preload-door engineer',
        yearsOfExperience: 2,
      });
      const designer = await db.insert(dynamicReferenceTestTables.Designer, {
        name: 'preload-door designer',
        specialization: 'Print',
      });
      const named: [string, { id: string }][] = [
        [dynamicReferenceTestTables.Engineer.name, engineer],
        [dynamicReferenceTestTables.Designer.name, designer],
      ];
      for (let i = 0; i < named.length; i++) {
        await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
          projectName: `preload-door project ${i}`,
          employeeRef: new Reference(named[i][0], named[i][1].id),
          startDate: '2026-01-01',
        });
      }

      // The tables as the service resolves them by name. For this case they carry doors: a signed-in person
      // reads all three through the Db; through the table service they read the assignments and the engineers,
      // and the designers are left to the default (an admin).
      const assignments = tableByName(dynamicReferenceTestTables.ProjectAssignment.name);
      const engineers = tableByName(dynamicReferenceTestTables.Engineer.name);
      const designers = tableByName(dynamicReferenceTestTables.Designer.name);
      const asDeclared = [assignments, engineers, designers].map((table) => [table, table.auth] as const);
      assignments.auth = { db: { all: 'authenticated' }, service: { query: 'authenticated' } };
      engineers.auth = { db: { all: 'authenticated' }, service: { query: 'authenticated' } };
      designers.auth = { db: { all: 'authenticated' } };

      /** The read as the service runs it: its arguments as a call's text reads them, the door asked, then the method. */
      const served = async (projectName: string): Promise<ProjectAssignment> => {
        const args: [Table<any>, any, any] = [
          assignments,
          JSON.parse(JSON.stringify({ projectName })),
          JSON.parse(JSON.stringify({ preloadReferences: { enabled: true, includeColumns: ['employeeRef'] } })),
        ];
        expect(db.serviceMetadata!.auth!.canAccess!('query', args)).toBe(true);
        return (await db.query(...args))[0];
      };

      try {
        // A signed-in person with no role.
        registerTestUser([]);
        expect((await served('preload-door project 0')).employeeRef!._object?.name).toBe('preload-door engineer');
        const ofTheDesigner = await served('preload-door project 1');
        expect(ofTheDesigner.employeeRef!._table).toBe(designers.name);
        expect(ofTheDesigner.employeeRef!._id).toBe(designer.id);
        expect(ofTheDesigner.employeeRef!._object).toBeUndefined();

        // The designers' service door admits an admin, and so the same read loads the designer for one.
        registerTestUser(['admin']);
        expect((await served('preload-door project 1')).employeeRef!._object?.name).toBe('preload-door designer');
      } finally {
        registerTestUser();
        for (const [table, auth] of asDeclared) {
          table.auth = auth;
        }
      }
    });
  };
};
