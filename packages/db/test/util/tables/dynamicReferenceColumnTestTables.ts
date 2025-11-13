import {
  DynamicReferenceColumn,
  StringColumn,
  DynamicReferenceTableNameColumn,
  Reference,
  Table,
  withRecordColumns,
  Record,
} from '@proteinjs/db';

export interface ProjectAssignment extends Record {
  projectName: string;
  employeeTableName?: string | null;
  employeeRef?: Reference<Engineer | Designer | ProjectManager> | null;
  projectLeadTableName?: string | null;
  projectLeadRef?: Reference<Engineer | Designer | ProjectManager> | null;
  startDate: string;
}

export interface Engineer extends Record {
  name: string;
  yearsOfExperience: number;
}

export interface Designer extends Record {
  name: string;
  specialization: string;
}

export interface ProjectManager extends Record {
  name: string;
  certificate: string;
}

export class ProjectAssignmentTable extends Table<ProjectAssignment> {
  name = 'db_test_dr_project_assignments';
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

export class EngineerTable extends Table<Engineer> {
  name = 'db_test_dr_engineers';
  columns = withRecordColumns<Engineer>({
    name: new StringColumn('name'),
    yearsOfExperience: new StringColumn('years_of_experience'),
  });
}

export class DesignerTable extends Table<Designer> {
  name = 'db_test_dr_designers';
  columns = withRecordColumns<Designer>({
    name: new StringColumn('name'),
    specialization: new StringColumn('specialization'),
  });
}

export class ProjectManagerTable extends Table<ProjectManager> {
  name = 'db_test_dr_project_managers';
  columns = withRecordColumns<ProjectManager>({
    name: new StringColumn('name'),
    certificate: new StringColumn('certificate'),
  });
}

export const dynamicReferenceTestTables = {
  ProjectAssignment: new ProjectAssignmentTable() as Table<ProjectAssignment>,
  Engineer: new EngineerTable() as Table<Engineer>,
  Designer: new DesignerTable() as Table<Designer>,
  ProjectManager: new ProjectManagerTable() as Table<ProjectManager>,
};
