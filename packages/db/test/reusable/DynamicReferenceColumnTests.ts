import { Db, DbDriver, Reference, Table } from '@proteinjs/db';
import { QueryBuilder } from '@proteinjs/db-query';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import {
  Designer,
  dynamicReferenceTestTables,
  Engineer,
  ProjectAssignment,
  ProjectManager,
} from '../util/tables/dynamicReferenceColumnTestTables';

export const dynamicReferenceColumnTests = (driver: DbDriver, dropTable: (table: Table<any>) => Promise<void>) => {
  return () => {
    const db = new Db(driver);
    const testEnv = new DbTestEnvironment(driver, dropTable);

    beforeAll(async () => await testEnv.beforeAll(), 10000);
    afterAll(async () => await testEnv.afterAll(), 10000);

    test('should handle references to different types', async () => {
      // Create an engineer
      const engineer = await db.insert(dynamicReferenceTestTables.Engineer, {
        name: 'John Doe',
        yearsOfExperience: 5,
      });

      // Create a designer
      const designer = await db.insert(dynamicReferenceTestTables.Designer, {
        name: 'Jane Smith',
        specialization: 'UI/UX',
      });

      // Assign both to different projects
      const engineerAssignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
        projectName: 'Backend API',
        employeeRef: new Reference(dynamicReferenceTestTables.Engineer.name, engineer.id),
        startDate: '2024-01-01',
      });

      const designerAssignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
        projectName: 'Website Redesign',
        employeeRef: new Reference(dynamicReferenceTestTables.Designer.name, designer.id),
        startDate: '2024-01-15',
      });

      // Verify engineer assignment
      const fetchedEngineerAssignment = await db.get(dynamicReferenceTestTables.ProjectAssignment, {
        id: engineerAssignment.id,
      });
      expect(fetchedEngineerAssignment.employeeRef?._table).toBe(dynamicReferenceTestTables.Engineer.name);
      expect(fetchedEngineerAssignment.employeeRef?._id).toBe(engineer.id);
      expect(fetchedEngineerAssignment.employeeTableName).toBe(dynamicReferenceTestTables.Engineer.name);

      // Verify designer assignment
      const fetchedDesignerAssignment = await db.get(dynamicReferenceTestTables.ProjectAssignment, {
        id: designerAssignment.id,
      });
      expect(fetchedDesignerAssignment.employeeRef?._table).toBe(dynamicReferenceTestTables.Designer.name);
      expect(fetchedDesignerAssignment.employeeRef?._id).toBe(designer.id);
      expect(fetchedDesignerAssignment.employeeTableName).toBe(dynamicReferenceTestTables.Designer.name);
    });

    test('should cascade delete multiple types of records when references are deleted', async () => {
      // Create employees
      const engineer = await db.insert(dynamicReferenceTestTables.Engineer, {
        name: 'John Doe',
        yearsOfExperience: 5,
      });

      const projectManager = await db.insert(dynamicReferenceTestTables.ProjectManager, {
        name: 'Alice Brown',
        certificate: 'Scrum Master',
      });

      const designer = await db.insert(dynamicReferenceTestTables.Designer, {
        name: 'Jane Smith',
        specialization: 'UI/UX',
      });

      // Create assignments
      const engineerAssignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
        projectName: 'Backend API',
        employeeRef: new Reference<Engineer>(dynamicReferenceTestTables.Engineer.name, engineer.id),
        startDate: '2024-01-01',
      });

      const pmAssignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
        projectName: 'Project Planning',
        employeeRef: new Reference<ProjectManager>(dynamicReferenceTestTables.ProjectManager.name, projectManager.id),
        startDate: '2024-01-10',
      });

      const designerAssignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
        projectName: 'Website Redesign',
        employeeRef: new Reference<Designer>(dynamicReferenceTestTables.Designer.name, designer.id),
        startDate: '2024-01-15',
      });

      // Delete the engineer's and PM's assignments - should cascade delete both
      const deleteQuery = new QueryBuilder<ProjectAssignment>(
        dynamicReferenceTestTables.ProjectAssignment.name
      ).condition({
        field: 'id',
        operator: 'IN',
        value: [engineerAssignment.id, pmAssignment.id],
      });
      const recordsDeleted = await db.delete(dynamicReferenceTestTables.ProjectAssignment, deleteQuery);

      expect(recordsDeleted).toBe(2);

      // Verify engineer and PM were deleted but designer remains
      const remainingEngineers = await db.query(dynamicReferenceTestTables.Engineer, { id: engineer.id });
      expect(remainingEngineers.length).toBe(0); // Engineer should be deleted

      const remainingPMs = await db.query(dynamicReferenceTestTables.ProjectManager, { id: projectManager.id });
      expect(remainingPMs.length).toBe(0); // PM should be deleted

      const remainingDesigners = await db.query(dynamicReferenceTestTables.Designer, { id: designer.id });
      expect(remainingDesigners.length).toBe(1); // Designer should still exist
      expect(remainingDesigners[0].id).toBe(designer.id);

      // Only designer assignment should still exist
      const remainingAssignmentsQuery = new QueryBuilder<ProjectAssignment>(
        dynamicReferenceTestTables.ProjectAssignment.name
      ).condition({
        field: 'id',
        operator: 'IN',
        value: [engineerAssignment.id, pmAssignment.id, designerAssignment.id],
      });
      const remainingAssignments = await db.query(
        dynamicReferenceTestTables.ProjectAssignment,
        remainingAssignmentsQuery
      );
      expect(remainingAssignments.length).toBe(1);
      expect(remainingAssignments[0].id).toBe(designerAssignment.id);
    });

    test('should allow changing table name when updating reference to new type', async () => {
      // Create employees
      const engineer = await db.insert(dynamicReferenceTestTables.Engineer, {
        name: 'John Doe',
        yearsOfExperience: 5,
      });

      const designer = await db.insert(dynamicReferenceTestTables.Designer, {
        name: 'Jane Smith',
        specialization: 'UI/UX',
      });

      // Create initial assignment to engineer
      const assignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
        projectName: 'Full Stack App',
        employeeRef: new Reference(dynamicReferenceTestTables.Engineer.name, engineer.id),
        startDate: '2024-01-01',
      });

      // Reassign to designer
      await db.update(
        dynamicReferenceTestTables.ProjectAssignment,
        {
          employeeRef: new Reference(dynamicReferenceTestTables.Designer.name, designer.id),
        },
        { id: assignment.id }
      );

      // Verify reassignment
      const updatedAssignment = await db.get(dynamicReferenceTestTables.ProjectAssignment, { id: assignment.id });
      expect(updatedAssignment.employeeRef).toBeDefined();
      expect(updatedAssignment.employeeRef?._table).toBe(dynamicReferenceTestTables.Designer.name);
      expect(updatedAssignment.employeeRef?._id).toBe(designer.id);
      expect(updatedAssignment.employeeTableName).toBe(dynamicReferenceTestTables.Designer.name);
    });

    describe('DynamicReferenceTableNameColumn behavior', () => {
      test('should handle defaultValue logic correctly', async () => {
        // Test case 1: Reference column is populated
        const engineer = await db.insert(dynamicReferenceTestTables.Engineer, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        const assignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
          projectName: 'Test Project',
          employeeRef: new Reference(dynamicReferenceTestTables.Engineer.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Verify table name was set correctly from reference
        expect(assignment.employeeTableName).toBe(dynamicReferenceTestTables.Engineer.name);

        // Test case 2: Reference column is null
        const assignmentNoRef = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
          projectName: 'No Reference Project',
          employeeRef: null,
          startDate: '2024-01-01',
        });

        // Verify table name is null when reference is null
        expect(assignmentNoRef.employeeTableName).toBeNull();

        // Test case 3: Reference without table name should throw
        await expect(
          db.insert(dynamicReferenceTestTables.ProjectAssignment, {
            projectName: 'Invalid Reference',
            employeeRef: new Reference('', engineer.id), // Empty table name
            startDate: '2024-01-01',
          })
        ).rejects.toThrow(/table name must be set in Reference object/);
      });

      test('should handle updateValue logic correctly', async () => {
        // Create initial records
        const engineer = await db.insert(dynamicReferenceTestTables.Engineer, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        const designer = await db.insert(dynamicReferenceTestTables.Designer, {
          name: 'Jane Smith',
          specialization: 'UI/UX',
        });

        const assignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
          projectName: 'Initial Project',
          employeeRef: new Reference(dynamicReferenceTestTables.Engineer.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Test case 1: Update reference to new table
        await db.update(
          dynamicReferenceTestTables.ProjectAssignment,
          {
            employeeRef: new Reference(dynamicReferenceTestTables.Designer.name, designer.id),
          },
          { id: assignment.id }
        );

        const updatedAssignment = await db.get(dynamicReferenceTestTables.ProjectAssignment, { id: assignment.id });
        expect(updatedAssignment.employeeTableName).toBe(dynamicReferenceTestTables.Designer.name);

        // Test case 2: Update without changing reference
        await db.update(
          dynamicReferenceTestTables.ProjectAssignment,
          {
            projectName: 'Updated Project Name',
          },
          { id: assignment.id }
        );

        const unchangedAssignment = await db.get(dynamicReferenceTestTables.ProjectAssignment, { id: assignment.id });
        expect(unchangedAssignment.employeeTableName).toBe(dynamicReferenceTestTables.Designer.name); // Should retain previous value

        // Test case 3: Update with invalid reference should throw
        await expect(
          db.update(
            dynamicReferenceTestTables.ProjectAssignment,
            {
              employeeRef: new Reference('', designer.id), // Empty table name
            },
            { id: assignment.id }
          )
        ).rejects.toThrow(/table name must be set in Reference object/);
      });

      test('should handle null references correctly', async () => {
        // Create initial assignment with reference
        const engineer = await db.insert(dynamicReferenceTestTables.Engineer, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        const assignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
          projectName: 'Initial Project',
          employeeRef: new Reference(dynamicReferenceTestTables.Engineer.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Update to null reference
        await db.update(
          dynamicReferenceTestTables.ProjectAssignment,
          {
            employeeRef: null,
          },
          { id: assignment.id }
        );

        const nullRefAssignment = await db.get(dynamicReferenceTestTables.ProjectAssignment, { id: assignment.id });
        expect(nullRefAssignment.employeeRef).toBeNull();
        expect(nullRefAssignment.employeeTableName).toBe(dynamicReferenceTestTables.Engineer.name); // Should retain previous value
      });

      test('should handle custom defaultValue override for projectLead', async () => {
        const engineer = await db.insert(dynamicReferenceTestTables.Engineer, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        // Even with a reference provided, should use the custom default value
        const assignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
          projectName: 'Custom Default Test',
          projectLeadRef: new Reference(dynamicReferenceTestTables.Engineer.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Should use our custom default value instead of the reference's table name
        expect(assignment.projectLeadTableName).toBe('TEST_DEFAULT_VALUE');
      });

      test('should handle custom updateValue override for projectLead', async () => {
        const engineer = await db.insert(dynamicReferenceTestTables.Engineer, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        const designer = await db.insert(dynamicReferenceTestTables.Designer, {
          name: 'Jane Smith',
          specialization: 'UI/UX',
        });

        // Create initial assignment
        const assignment = await db.insert(dynamicReferenceTestTables.ProjectAssignment, {
          projectName: 'Initial Project',
          projectLeadRef: new Reference(dynamicReferenceTestTables.Engineer.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Update the reference
        await db.update(
          dynamicReferenceTestTables.ProjectAssignment,
          {
            projectLeadRef: new Reference(dynamicReferenceTestTables.Designer.name, designer.id),
          },
          { id: assignment.id }
        );

        const updatedAssignment = await db.get(dynamicReferenceTestTables.ProjectAssignment, { id: assignment.id });
        // Should use our custom update value instead of the new reference's table name
        expect(updatedAssignment.projectLeadTableName).toBe('TEST_UPDATE_VALUE');
      });
    });
  };
};
