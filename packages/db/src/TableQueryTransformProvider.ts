import { ColumnQueryTransform, ColumnQueryTransformProvider } from '@proteinjs/db-query';
import { Column, ColumnQueryRuntime, Table } from './Table';

/**
 * The Table-model side of db-query's column query-transform seam: resolves a
 * (tableName, columnProperty) pair to the column's own `Column.queryTransform`, built with
 * the current operation's `ColumnQueryRuntime`. `Db.addColumnQueries` hands one of these
 * to `QueryBuilder.applyColumnTransforms` on every query, so a column's query contract is
 * consulted wherever the column is used — including inside subquery values on other
 * tables, resolved through the same table registry the statement layer uses.
 */
export class TableQueryTransformProvider implements ColumnQueryTransformProvider {
  constructor(
    private getTable: (tableName: string) => Table<any>,
    private runtime: ColumnQueryRuntime
  ) {}

  getTransform(tableName: string, columnPropertyName: string): ColumnQueryTransform | undefined {
    let table: Table<any>;
    try {
      table = this.getTable(tableName);
    } catch {
      // Not a registered table (e.g. an aggregate '*' field, or a name outside the model) —
      // nothing to consult.
      return undefined;
    }

    const column = (table.columns as any)[columnPropertyName] as Column<any, any> | undefined;
    return column?.queryTransform?.(this.runtime);
  }
}
