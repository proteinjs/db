import React from 'react';
import { Delete, Add } from '@mui/icons-material';
import S from 'string';
import { Typography } from '@mui/material';
import {
  BooleanCellValue,
  ClampedTextCellValue,
  CustomRenderer,
  DateCellValue,
  DateTimeCellValue,
  EmptyCellValue,
  JsonSnippetCellValue,
  StatusChipCellValue,
  TableButton,
  Table as TableComponent,
  TableLoader,
  TableProps,
  isStatusLikeColumnName,
} from '@proteinjs/ui';
import {
  Column,
  QueryBuilderFactory,
  Record,
  ReferenceArrayColumn,
  ReferenceColumn,
  Table,
  TableAuth,
  getDb,
} from '@proteinjs/db';
import { QueryTableLoader } from './QueryTableLoader';
import { newRecordFormLink, recordFormLink } from '../pages/RecordFormPage';
import { recordTableLink } from '../pages/RecordTablePage';
import { tableDisplayName } from '../tableDisplayName';
import { ReferenceArrayCellValue, ReferenceCellValue } from './ReferenceCellValue';
import { isInstanceOf } from '@proteinjs/util';
import {
  IntegerColumn,
  StringColumn,
  FloatColumn,
  DecimalColumn,
  BooleanColumn,
  DateColumn,
  DateTimeColumn,
  ObjectColumn,
  ArrayColumn,
} from '@proteinjs/db';

type TablePropsToOmit = 'tableLoader' | 'columns';
type SpecificTableProps<T> = Omit<TableProps<T>, TablePropsToOmit>;

export type RecordTableProps<T extends Record> = {
  table: Table<T>;
  tableLoader?: TableLoader<T>;
  columns?: TableProps<T>['columns'];
  hideButtons?: boolean;
} & SpecificTableProps<T>;

function deleteButton<T extends Record>(table: Table<T>): TableButton<T> {
  return {
    name: `Delete selected rows`,
    icon: Delete,
    visibility: {
      showWhenRowsSelected: true,
      showWhenNoRowsSelected: false,
    },
    confirm: (selectedRows) => ({
      title: `Delete ${selectedRows.length} ${selectedRows.length == 1 ? 'row' : 'rows'}?`,
      message: `This permanently deletes ${
        selectedRows.length == 1 ? 'the selected row' : 'the selected rows'
      } from ${tableDisplayName(table)}.`,
      confirmButtonText: 'Delete',
    }),
    onClick: async (selectedRows, navigate) => {
      const qb = new QueryBuilderFactory()
        .getQueryBuilder(table)
        .condition({ field: 'id', operator: 'IN', value: selectedRows.map((row) => row.id) as T[keyof T][] });
      await getDb().delete(table, qb);
      navigate(recordTableLink(table));
    },
  };
}

function createButton<T extends Record>(table: Table<T>): TableButton<T> {
  return {
    name: `Create ${S(table.name).humanize().s}`,
    icon: Add,
    visibility: {
      showWhenRowsSelected: false,
      showWhenNoRowsSelected: true,
    },
    onClick: async (selectedRows, navigate) => {
      navigate(newRecordFormLink(table.name));
    },
  };
}

/**
 * The meaningful-data default column pick (the founder's ask — a record table should surface
 * what a human scans for, not the schema's first columns). Deterministic tiers over the
 * visible (non-`ui.hidden`) columns:
 *   name → identity strings (email/title/description/…) → status-like short strings →
 *   booleans → references (they render as linked names now) → the rest in schema order,
 *   with long-text columns (maxLength ≥ 1000) demoted to the back.
 * Capped at five + created/updated, exactly as before — the tiers change WHICH five.
 *
 * Unbounded ('MAX') plain-text columns never join the default pick: a table row can't afford
 * a value with no length cap (the record FORM is where those surface now — founder ruling,
 * admin round 3). This is the table layer's own rule, not a `ui.hidden` default — an explicit
 * `columns` prop can still request such a column (the cell grammar clamps it to three lines).
 * Object/Array columns are exempt (their storage is MAX but they render as mono JSON snippets).
 */
export function defaultRecordTableColumns<T extends Record>(table: Table<T>): (keyof T)[] {
  // A table that declares its row columns owns the pick outright (Table.ui.recordTable.columns
  // — the framework renders what tables declare); created/updated still join at the end, the
  // record family's shared face, unless the declaration already seats them.
  const declaredColumns = table.ui?.recordTable?.columns;
  if (declaredColumns) {
    const columnProperties = [...declaredColumns] as (keyof T)[];
    for (const recordColumn of ['created', 'updated'] as (keyof T)[]) {
      if ((table.columns as any)[recordColumn] && !columnProperties.includes(recordColumn)) {
        columnProperties.push(recordColumn);
      }
    }
    return columnProperties;
  }

  function isIdentityName(name: string) {
    // suffix match so compound names promote too (userEmail, jobTitle)
    return name.endsWith('email') || name.endsWith('title') || ['description', 'label', 'subject'].includes(name);
  }

  function tier(columnPropertyName: string, column: Column<T, any>): number {
    const name = columnPropertyName.toLowerCase();
    if (isIdentityName(name)) {
      return 1;
    }
    if (isStatusLikeColumnName(name) && isInstanceOf(column, StringColumn)) {
      return 2;
    }
    if (isInstanceOf(column, BooleanColumn)) {
      return 3;
    }
    if (isInstanceOf(column, ReferenceColumn)) {
      return 4;
    }
    if (isInstanceOf(column, StringColumn)) {
      const { maxLength } = column as unknown as StringColumn;
      if (maxLength === 'MAX' || maxLength >= 1000) {
        return 6;
      }
    }
    return 5;
  }

  const candidates = Object.keys(table.columns)
    .filter((columnPropertyName) => {
      if (['name', 'id', 'created', 'updated'].includes(columnPropertyName)) {
        return false;
      }

      const column: Column<T, any> = (table.columns as any)[columnPropertyName];
      if (column.options?.ui?.hidden) {
        return false;
      }

      // Unbounded plain text stays out of the default pick (see the doc above).
      if (isInstanceOf(column, StringColumn) && !isInstanceOf(column, ObjectColumn)) {
        const { maxLength } = column as unknown as StringColumn;
        if (maxLength === 'MAX') {
          return false;
        }
      }

      return true;
    })
    .map((columnPropertyName, index) => ({
      columnPropertyName,
      index,
      tier: tier(columnPropertyName, (table.columns as any)[columnPropertyName]),
    }))
    .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.index - b.index));

  const columnProperties: (keyof T)[] = [];
  if ((table.columns as any)['name']) {
    columnProperties.push('name' as keyof T);
  }

  for (const candidate of candidates) {
    if (columnProperties.length >= 5) {
      break;
    }

    columnProperties.push(candidate.columnPropertyName as keyof T);
  }

  if ((table.columns as any)['created']) {
    columnProperties.push('created' as keyof T);
  }
  if ((table.columns as any)['updated']) {
    columnProperties.push('updated' as keyof T);
  }

  return columnProperties;
}

export function RecordTable<T extends Record>(props: RecordTableProps<T>) {
  const { ...passthrough } = props;
  function defaultColumns() {
    return defaultRecordTableColumns(props.table);
  }

  /**
   * The per-COLUMN-TYPE default presentations, on the base table's shared cell grammar
   * (@proteinjs/ui cellValues): references as linked names, booleans as check/dash, dates
   * humanized, blobs as mono snippets, status-like strings as quiet chips. A consumer's
   * `columnConfig.renderer` replaces any of these per column.
   */
  function getDefaultRenderer(column: Column<any, any>, columnPropertyName: string): CustomRenderer<T, any> {
    return (value: any) => {
      if (value == null || value === '') {
        return <EmptyCellValue />;
      }
      if (isInstanceOf(column, ReferenceColumn)) {
        const { referenceTable } = column as unknown as ReferenceColumn<any>;
        return <ReferenceCellValue tableName={value?._table || referenceTable} id={value?._id} />;
      }
      if (isInstanceOf(column, ReferenceArrayColumn)) {
        const { referenceTable } = column as unknown as ReferenceArrayColumn<any>;
        return <ReferenceArrayCellValue tableName={value?._table || referenceTable} ids={value?._ids} />;
      }
      // Reference-shaped values on columns the registry didn't type (defensive: pre-rev rows)
      if (value && typeof value === 'object' && '_id' in value && typeof value._id === 'string') {
        return <ReferenceCellValue tableName={value._table} id={value._id} />;
      }
      if (value && typeof value === 'object' && '_ids' in value && Array.isArray(value._ids)) {
        return <ReferenceArrayCellValue tableName={value._table} ids={value._ids} />;
      }
      if (isInstanceOf(column, ObjectColumn) || isInstanceOf(column, ArrayColumn)) {
        return <JsonSnippetCellValue value={value} />;
      }
      if (
        isInstanceOf(column, IntegerColumn) ||
        isInstanceOf(column, FloatColumn) ||
        isInstanceOf(column, DecimalColumn)
      ) {
        return (
          <Typography variant='body2' component='span' sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {value.toString()}
          </Typography>
        );
      }
      if (isInstanceOf(column, BooleanColumn)) {
        return <BooleanCellValue value={value} />;
      }
      if (isInstanceOf(column, DateColumn)) {
        return <DateCellValue value={value} />;
      }
      if (isInstanceOf(column, DateTimeColumn)) {
        return <DateTimeCellValue value={value} />;
      }
      if (isInstanceOf(column, StringColumn)) {
        const text = String(value);
        // Status-like short values scan as chips; anything longer stays clamped text.
        if (isStatusLikeColumnName(columnPropertyName) && text.length <= 24) {
          return <StatusChipCellValue value={text} />;
        }
        return <ClampedTextCellValue>{text}</ClampedTextCellValue>;
      }
      return <ClampedTextCellValue>{value.toString()}</ClampedTextCellValue>;
    };
  }

  function mergeColumnConfigs(): TableProps<T>['columnConfig'] {
    const defaultConfig: TableProps<T>['columnConfig'] = {};
    const columns = props.columns || defaultColumns();

    for (const columnName of columns) {
      const column = (props.table.columns as any)[columnName];
      const isNumeric =
        isInstanceOf(column, IntegerColumn) || isInstanceOf(column, FloatColumn) || isInstanceOf(column, DecimalColumn);
      // Plain strings ride the base Table's own default path (body2 + three-line clamp, quiet
      // dash for empties, and the phone card's identity emphasis + empty-field omission) —
      // a renderer here would just re-implement that and lose the card behaviors.
      const isPlainString =
        isInstanceOf(column, StringColumn) &&
        !isStatusLikeColumnName(columnName as string) &&
        !isInstanceOf(column, ReferenceColumn) &&
        !isInstanceOf(column, ObjectColumn) &&
        !isInstanceOf(column, DateColumn) &&
        !isInstanceOf(column, DateTimeColumn);
      if (isPlainString) {
        continue;
      }

      defaultConfig[columnName] = {
        renderer: getDefaultRenderer(column, columnName as string),
        // The type renderers are value-driven: an empty value means an empty card field.
        omitEmptyOnCard: true,
        // Numbers right-align (they compare by magnitude); a consumer's cellProps replaces this.
        ...(isNumeric ? { cellProps: { align: 'right' as const } } : {}),
      };
    }

    // Merge with provided columnConfig, if any — including columns with no default entry
    // (plain strings ride the base default, but a consumer's config must still land).
    if (props.columnConfig) {
      for (const columnName in props.columnConfig) {
        defaultConfig[columnName] = {
          ...defaultConfig[columnName],
          ...props.columnConfig[columnName],
        };
      }
    }

    return defaultConfig;
  }

  function defaultTableLoader() {
    return new QueryTableLoader(props.table, undefined, [{ field: 'updated', desc: true }]);
  }

  async function defaultRowOnClickRedirectUrl(row: T) {
    return recordFormLink(props.table.name, row.id);
  }

  /**
   * The default affordances DERIVE from the table's declared auth doors — an operation the
   * declaration doesn't open for the current user draws no button (a create button on the
   * session table, whose rows are system-written, could only lead to a refused save). A UI act
   * rides the service RPC and DbService's inner Db re-checks the db api as the calling user,
   * so an affordance requires BOTH doors. Explicit `buttons` props pass through untouched.
   */
  function buttons() {
    if (props.hideButtons) {
      return [];
    }

    if (props.buttons) {
      return props.buttons;
    }

    const tableAuth = new TableAuth();
    const canPerform = (operation: 'insert' | 'delete') =>
      tableAuth.canPerform(props.table, operation, 'service') && tableAuth.canPerform(props.table, operation, 'db');

    const derivedButtons: TableButton<T>[] = [];
    if (canPerform('delete')) {
      derivedButtons.push(deleteButton(props.table));
    }
    if (canPerform('insert')) {
      derivedButtons.push(createButton(props.table));
    }
    return derivedButtons;
  }

  return (
    <TableComponent
      title={props.title ? props.title : tableDisplayName(props.table)}
      columns={props.columns ? props.columns : defaultColumns()}
      columnConfig={mergeColumnConfigs()}
      tableLoader={props.tableLoader ? props.tableLoader : defaultTableLoader()}
      rowOnClick={props.rowOnClick ? props.rowOnClick : defaultRowOnClickRedirectUrl}
      buttons={buttons()}
      {...passthrough}
    />
  );
}
