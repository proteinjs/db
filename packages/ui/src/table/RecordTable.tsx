import React from 'react';
import { Delete, Add } from '@mui/icons-material';
import S from 'string';
import { CustomRenderer, TableButton, Table as TableComponent, TableLoader, TableProps } from '@proteinjs/ui';
import { Column, QueryBuilderFactory, Record, Table, getDb } from '@proteinjs/db';
import { QueryTableLoader } from './QueryTableLoader';
import { newRecordFormLink, recordFormLink } from '../pages/RecordFormPage';
import { recordTableLink } from '../pages/RecordTablePage';
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
import moment from 'moment';

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

export function RecordTable<T extends Record>(props: RecordTableProps<T>) {
  const { ...passthrough } = props;
  function defaultColumns() {
    const columnProperties: (keyof T)[] = [];
    if ((props.table.columns as any)['name']) {
      columnProperties.push('name' as keyof T);
    }

    for (const columnProperty of Object.keys(props.table.columns)) {
      if (columnProperties.length >= 5) {
        break;
      }

      if (columnProperty == 'name' || columnProperty == 'created' || columnProperty == 'updated') {
        continue;
      }

      const column: Column<T, any> = (props.table.columns as any)[columnProperty];
      if (column.options?.ui?.hidden) {
        continue;
      }

      columnProperties.push(columnProperty as keyof T);
    }

    columnProperties.push('created');
    columnProperties.push('updated');

    return columnProperties;
  }

  function getDefaultRenderer(column: Column<any, any>): CustomRenderer<T, any> {
    return (value: any) => {
      if (
        isInstanceOf(column, IntegerColumn) ||
        isInstanceOf(column, FloatColumn) ||
        isInstanceOf(column, DecimalColumn)
      ) {
        return value != null ? value.toString() : '';
      }
      if (isInstanceOf(column, StringColumn)) {
        return value || '';
      }
      if (isInstanceOf(column, BooleanColumn)) {
        return value ? '✅' : '❌';
      }
      if (isInstanceOf(column, DateColumn)) {
        return value ? moment(value).format('YYYY-MM-DD') : '';
      }
      if (isInstanceOf(column, DateTimeColumn)) {
        return value ? moment(value).format('YYYY-MM-DD HH:mm:ss') : '';
      }
      if (isInstanceOf(column, ObjectColumn) || isInstanceOf(column, ArrayColumn)) {
        return JSON.stringify(value);
      }
      return value != null ? value.toString() : '';
    };
  }

  function mergeColumnConfigs(): TableProps<T>['columnConfig'] {
    const defaultConfig: TableProps<T>['columnConfig'] = {};
    const columns = props.columns || defaultColumns();

    for (const columnName of columns) {
      const column = (props.table.columns as any)[columnName];
      defaultConfig[columnName] = {
        renderer: getDefaultRenderer(column),
      };
    }

    // Merge with provided columnConfig, if any
    if (props.columnConfig) {
      for (const columnName in props.columnConfig) {
        if (defaultConfig[columnName]) {
          defaultConfig[columnName] = {
            ...defaultConfig[columnName],
            ...props.columnConfig[columnName],
          };
        }
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

  function buttons() {
    if (props.hideButtons) {
      return [];
    }

    if (props.buttons) {
      return props.buttons;
    }

    return [deleteButton(props.table), createButton(props.table)];
  }

  return (
    <TableComponent
      title={props.title ? props.title : `${S(props.table.name).humanize().toString()} Table`}
      columns={props.columns ? props.columns : defaultColumns()}
      columnConfig={mergeColumnConfigs()}
      tableLoader={props.tableLoader ? props.tableLoader : defaultTableLoader()}
      rowOnClick={props.rowOnClick ? props.rowOnClick : defaultRowOnClickRedirectUrl}
      buttons={buttons()}
      {...passthrough}
    />
  );
}
