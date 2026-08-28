import { Db, DbDriver, QueryBuilderFactory, Reference, ReferenceArray, Table } from '@proteinjs/db';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import { dynamicReferenceTestTables } from '../util/tables/dynamicReferenceColumnTestTables';
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
  };
};
