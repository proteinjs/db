import { DynamicReferenceColumn, StringColumn, DynamicReferenceTableNameColumn } from '../../src/Columns';
import { Db, DbDriver } from '../../src/Db';
import { Reference } from '../../src/reference/Reference';
import { Table } from '../../src/Table';
import { withRecordColumns, Record } from '../../src/Record';
import { QueryBuilder } from '@proteinjs/db-query';

interface ProjectAssignment extends Record {
  projectName: string;
  employeeTableName?: string | null;
  employeeRef?: Reference<Engineer | Designer | ProjectManager> | null;
  projectLeadTableName?: string | null;
  projectLeadRef?: Reference<Engineer | Designer | ProjectManager> | null;
  startDate: string;
}

interface Engineer extends Record {
  name: string;
  yearsOfExperience: number;
}

interface Designer extends Record {
  name: string;
  specialization: string;
}

interface ProjectManager extends Record {
  name: string;
  certificate: string;
}

class ProjectAssignmentTable extends Table<ProjectAssignment> {
  name = 'db_test_project_assignments';
  columns = withRecordColumns<ProjectAssignment>({
    projectName: new StringColumn('project_name'),
    employeeTableName: new DynamicReferenceTableNameColumn('employee_table_name', 'employee_ref'),
    employeeRef: new DynamicReferenceColumn<Engineer | Designer | ProjectManager>(
      'employee_ref',
      'employee_table_name',
      true // Enable cascade delete for testing
    ),
    projectLeadTableName: new DynamicReferenceTableNameColumn('project_lead_table_name', 'project_lead_ref', {
      defaultValue: async () => 'TEST_DEFAULT_VALUE',
      updateValue: async () => 'TEST_UPDATE_VALUE',
    }),
    projectLeadRef: new DynamicReferenceColumn<Engineer | Designer | ProjectManager>(
      'project_lead_ref',
      'project_lead_table_name',
      true // Enable cascade delete for testing
    ),
    startDate: new StringColumn('start_date'),
  });
}

class EngineerTable extends Table<Engineer> {
  name = 'db_test_engineers';
  columns = withRecordColumns<Engineer>({
    name: new StringColumn('name'),
    yearsOfExperience: new StringColumn('years_of_experience'),
  });
}

class DesignerTable extends Table<Designer> {
  name = 'db_test_designers';
  columns = withRecordColumns<Designer>({
    name: new StringColumn('name'),
    specialization: new StringColumn('specialization'),
  });
}

class ProjectManagerTable extends Table<ProjectManager> {
  name = 'db_test_project_managers';
  columns = withRecordColumns<ProjectManager>({
    name: new StringColumn('name'),
    certificate: new StringColumn('certificate'),
  });
}

// Invalid table with missing DynamicReferenceTableNameColumn
class InvalidTableMissingTableName extends Table<Record> {
  name = 'db_test_invalid_missing_table_name';
  columns = withRecordColumns<Record>({
    // Only has DynamicReferenceColumn without its required table name column
    employeeRef: new DynamicReferenceColumn<Engineer | Designer | ProjectManager>(
      'employee_ref',
      'employee_table_name', // References a non-existent column
      true
    ),
  });
}

// Invalid table with unused DynamicReferenceTableNameColumn
class InvalidTableUnusedTableName extends Table<Record> {
  name = 'db_test_invalid_unused_table_name';
  columns = withRecordColumns<Record>({
    // Has DynamicReferenceTableNameColumn but no DynamicReferenceColumn using it
    employeeTableName: new DynamicReferenceTableNameColumn('employee_table_name', 'employee_ref'),
  });
}

/** Used for testing purposes only. */
export const getDynamicReferenceColumnTestTable = (tableName: string) => {
  const projectAssignmentTable = new ProjectAssignmentTable();
  const engineerTable = new EngineerTable();
  const designerTable = new DesignerTable();
  const projectManagerTable = new ProjectManagerTable();

  switch (tableName) {
    case projectAssignmentTable.name:
      return projectAssignmentTable;
    case engineerTable.name:
      return engineerTable;
    case designerTable.name:
      return designerTable;
    case projectManagerTable.name:
      return projectManagerTable;
    default:
      throw new Error(`Cannot find test table: ${tableName}`);
  }
};

// Test suite
export const dynamicReferenceColumnTests = (driver: DbDriver, dropTable: (table: Table<any>) => Promise<void>) => {
  return () => {
    let projectAssignmentTable: Table<ProjectAssignment>;
    let engineerTable: Table<Engineer>;
    let designerTable: Table<Designer>;
    let projectManagerTable: Table<ProjectManager>;
    const db = new Db(driver, getDynamicReferenceColumnTestTable);

    beforeAll(async () => {
      if (driver.start) {
        await driver.start();
      }

      await driver.getTableManager().loadTable(new ProjectAssignmentTable());
      await driver.getTableManager().loadTable(new EngineerTable());
      await driver.getTableManager().loadTable(new DesignerTable());
      await driver.getTableManager().loadTable(new ProjectManagerTable());
    });

    beforeEach(async () => {
      await driver.getTableManager().loadTable(new ProjectAssignmentTable());
      await driver.getTableManager().loadTable(new EngineerTable());
      await driver.getTableManager().loadTable(new DesignerTable());
      await driver.getTableManager().loadTable(new ProjectManagerTable());

      projectAssignmentTable = new ProjectAssignmentTable();
      engineerTable = new EngineerTable();
      designerTable = new DesignerTable();
      projectManagerTable = new ProjectManagerTable();
    });

    afterEach(async () => {
      await dropTable(new ProjectAssignmentTable());
      await dropTable(new EngineerTable());
      await dropTable(new DesignerTable());
      await dropTable(new ProjectManagerTable());
    });

    describe('TableManager validation', () => {
      test('should throw error when DynamicReferenceTableNameColumn is missing', async () => {
        const invalidTable = new InvalidTableMissingTableName();

        await expect(async () => {
          await driver.getTableManager().loadTable(invalidTable);
        }).rejects.toThrow(/missing its required DynamicReferenceTableNameColumn 'employee_table_name'/);
      });

      test('should throw error when DynamicReferenceTableNameColumn is unused', async () => {
        const invalidTable = new InvalidTableUnusedTableName();

        await expect(async () => {
          await driver.getTableManager().loadTable(invalidTable);
        }).rejects.toThrow(
          /has a DynamicReferenceTableNameColumn 'employee_table_name' but no DynamicReferenceColumn references it/
        );
      });
    });

    test('should handle references to different types', async () => {
      // Create an engineer
      const engineer = await db.insert(engineerTable, {
        name: 'John Doe',
        yearsOfExperience: 5,
      });

      // Create a designer
      const designer = await db.insert(designerTable, {
        name: 'Jane Smith',
        specialization: 'UI/UX',
      });

      // Assign both to different projects
      const engineerAssignment = await db.insert(projectAssignmentTable, {
        projectName: 'Backend API',
        employeeRef: new Reference(engineerTable.name, engineer.id),
        startDate: '2024-01-01',
      });

      const designerAssignment = await db.insert(projectAssignmentTable, {
        projectName: 'Website Redesign',
        employeeRef: new Reference(designerTable.name, designer.id),
        startDate: '2024-01-15',
      });

      // Verify engineer assignment
      const fetchedEngineerAssignment = await db.get(projectAssignmentTable, { id: engineerAssignment.id });
      expect(fetchedEngineerAssignment.employeeRef?._table).toBe(engineerTable.name);
      expect(fetchedEngineerAssignment.employeeRef?._id).toBe(engineer.id);
      expect(fetchedEngineerAssignment.employeeTableName).toBe(engineerTable.name);

      // Verify designer assignment
      const fetchedDesignerAssignment = await db.get(projectAssignmentTable, { id: designerAssignment.id });
      expect(fetchedDesignerAssignment.employeeRef?._table).toBe(designerTable.name);
      expect(fetchedDesignerAssignment.employeeRef?._id).toBe(designer.id);
      expect(fetchedDesignerAssignment.employeeTableName).toBe(designerTable.name);
    });

    test('should cascade delete multiple types of records when references are deleted', async () => {
      // Create employees
      const engineer = await db.insert(engineerTable, {
        name: 'John Doe',
        yearsOfExperience: 5,
      });

      const projectManager = await db.insert(projectManagerTable, {
        name: 'Alice Brown',
        certificate: 'Scrum Master',
      });

      const designer = await db.insert(designerTable, {
        name: 'Jane Smith',
        specialization: 'UI/UX',
      });

      // Create assignments
      const engineerAssignment = await db.insert(projectAssignmentTable, {
        projectName: 'Backend API',
        employeeRef: new Reference<Engineer>(engineerTable.name, engineer.id),
        startDate: '2024-01-01',
      });

      const pmAssignment = await db.insert(projectAssignmentTable, {
        projectName: 'Project Planning',
        employeeRef: new Reference<ProjectManager>(projectManagerTable.name, projectManager.id),
        startDate: '2024-01-10',
      });

      const designerAssignment = await db.insert(projectAssignmentTable, {
        projectName: 'Website Redesign',
        employeeRef: new Reference<Designer>(designerTable.name, designer.id),
        startDate: '2024-01-15',
      });

      // Delete the engineer's and PM's assignments - should cascade delete both
      const deleteQuery = new QueryBuilder<ProjectAssignment>(projectAssignmentTable.name).condition({
        field: 'id',
        operator: 'IN',
        value: [engineerAssignment.id, pmAssignment.id],
      });
      const recordsDeleted = await db.delete(projectAssignmentTable, deleteQuery);

      expect(recordsDeleted).toBe(2);

      // Verify engineer and PM were deleted but designer remains
      const remainingEngineers = await db.query(engineerTable, {});
      expect(remainingEngineers.length).toBe(0); // Engineer should be deleted

      const remainingPMs = await db.query(projectManagerTable, {});
      expect(remainingPMs.length).toBe(0); // PM should be deleted

      const remainingDesigners = await db.query(designerTable, {});
      expect(remainingDesigners.length).toBe(1); // Designer should still exist
      expect(remainingDesigners[0].id).toBe(designer.id);

      // Only designer assignment should still exist
      const remainingAssignments = await db.query(projectAssignmentTable, {});
      expect(remainingAssignments.length).toBe(1);
      expect(remainingAssignments[0].id).toBe(designerAssignment.id);
    });

    test('should allow changing table name when updating reference to new type', async () => {
      // Create employees
      const engineer = await db.insert(engineerTable, {
        name: 'John Doe',
        yearsOfExperience: 5,
      });

      const designer = await db.insert(designerTable, {
        name: 'Jane Smith',
        specialization: 'UI/UX',
      });

      // Create initial assignment to engineer
      const assignment = await db.insert(projectAssignmentTable, {
        projectName: 'Full Stack App',
        employeeRef: new Reference(engineerTable.name, engineer.id),
        startDate: '2024-01-01',
      });

      // Reassign to designer
      await db.update(
        projectAssignmentTable,
        {
          employeeRef: new Reference(designerTable.name, designer.id),
        },
        { id: assignment.id }
      );

      // Verify reassignment
      const updatedAssignment = await db.get(projectAssignmentTable, { id: assignment.id });
      expect(updatedAssignment.employeeRef).toBeDefined();
      expect(updatedAssignment.employeeRef?._table).toBe(designerTable.name);
      expect(updatedAssignment.employeeRef?._id).toBe(designer.id);
      expect(updatedAssignment.employeeTableName).toBe(designerTable.name);
    });

    describe('DynamicReferenceTableNameColumn behavior', () => {
      test('should handle defaultValue logic correctly', async () => {
        // Test case 1: Reference column is populated
        const engineer = await db.insert(engineerTable, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        const assignment = await db.insert(projectAssignmentTable, {
          projectName: 'Test Project',
          employeeRef: new Reference(engineerTable.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Verify table name was set correctly from reference
        expect(assignment.employeeTableName).toBe(engineerTable.name);

        // Test case 2: Reference column is null
        const assignmentNoRef = await db.insert(projectAssignmentTable, {
          projectName: 'No Reference Project',
          employeeRef: null,
          startDate: '2024-01-01',
        });

        // Verify table name is null when reference is null
        expect(assignmentNoRef.employeeTableName).toBeNull();

        // Test case 3: Reference without table name should throw
        await expect(
          db.insert(projectAssignmentTable, {
            projectName: 'Invalid Reference',
            employeeRef: new Reference('', engineer.id), // Empty table name
            startDate: '2024-01-01',
          })
        ).rejects.toThrow(/table name must be set in Reference object/);
      });

      test('should handle updateValue logic correctly', async () => {
        // Create initial records
        const engineer = await db.insert(engineerTable, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        const designer = await db.insert(designerTable, {
          name: 'Jane Smith',
          specialization: 'UI/UX',
        });

        const assignment = await db.insert(projectAssignmentTable, {
          projectName: 'Initial Project',
          employeeRef: new Reference(engineerTable.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Test case 1: Update reference to new table
        await db.update(
          projectAssignmentTable,
          {
            employeeRef: new Reference(designerTable.name, designer.id),
          },
          { id: assignment.id }
        );

        const updatedAssignment = await db.get(projectAssignmentTable, { id: assignment.id });
        expect(updatedAssignment.employeeTableName).toBe(designerTable.name);

        // Test case 2: Update without changing reference
        await db.update(
          projectAssignmentTable,
          {
            projectName: 'Updated Project Name',
          },
          { id: assignment.id }
        );

        const unchangedAssignment = await db.get(projectAssignmentTable, { id: assignment.id });
        expect(unchangedAssignment.employeeTableName).toBe(designerTable.name); // Should retain previous value

        // Test case 3: Update with invalid reference should throw
        await expect(
          db.update(
            projectAssignmentTable,
            {
              employeeRef: new Reference('', designer.id), // Empty table name
            },
            { id: assignment.id }
          )
        ).rejects.toThrow(/table name must be set in Reference object/);
      });

      test('should handle null references correctly', async () => {
        // Create initial assignment with reference
        const engineer = await db.insert(engineerTable, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        const assignment = await db.insert(projectAssignmentTable, {
          projectName: 'Initial Project',
          employeeRef: new Reference(engineerTable.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Update to null reference
        await db.update(
          projectAssignmentTable,
          {
            employeeRef: null,
          },
          { id: assignment.id }
        );

        const nullRefAssignment = await db.get(projectAssignmentTable, { id: assignment.id });
        expect(nullRefAssignment.employeeRef).toBeNull();
        expect(nullRefAssignment.employeeTableName).toBe(engineerTable.name); // Should retain previous value
      });

      test('should handle custom defaultValue override for projectLead', async () => {
        const engineer = await db.insert(engineerTable, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        // Even with a reference provided, should use the custom default value
        const assignment = await db.insert(projectAssignmentTable, {
          projectName: 'Custom Default Test',
          projectLeadRef: new Reference(engineerTable.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Should use our custom default value instead of the reference's table name
        expect(assignment.projectLeadTableName).toBe('TEST_DEFAULT_VALUE');
      });

      test('should handle custom updateValue override for projectLead', async () => {
        const engineer = await db.insert(engineerTable, {
          name: 'John Doe',
          yearsOfExperience: 5,
        });

        const designer = await db.insert(designerTable, {
          name: 'Jane Smith',
          specialization: 'UI/UX',
        });

        // Create initial assignment
        const assignment = await db.insert(projectAssignmentTable, {
          projectName: 'Initial Project',
          projectLeadRef: new Reference(engineerTable.name, engineer.id),
          startDate: '2024-01-01',
        });

        // Update the reference
        await db.update(
          projectAssignmentTable,
          {
            projectLeadRef: new Reference(designerTable.name, designer.id),
          },
          { id: assignment.id }
        );

        const updatedAssignment = await db.get(projectAssignmentTable, { id: assignment.id });
        // Should use our custom update value instead of the new reference's table name
        expect(updatedAssignment.projectLeadTableName).toBe('TEST_UPDATE_VALUE');
      });
    });
  };
};
