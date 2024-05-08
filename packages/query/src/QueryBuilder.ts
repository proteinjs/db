/* eslint-disable no-case-declarations */
import { Logger, Graph, isInstanceOf } from '@proteinjs/util';
import { Statement, StatementConfig, StatementParamManager } from './StatementFactory';

export interface Select<T> {
  fields?: (keyof T)[];
}

export type LogicalOperator = 'AND' | 'OR';
export type Operator =
  | '='
  | '<>'
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'IN'
  | 'NOT IN'
  | 'LIKE'
  | 'NOT LIKE'
  | 'BETWEEN'
  | 'IS NULL'
  | 'IS NOT NULL'
  | 'NOT';
export type AggregateFunction = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export interface LogicalGroup<T> {
  operator: LogicalOperator;
  children: Array<Condition<T> | LogicalGroup<T>>;
}

export interface Condition<T> {
  field: keyof T;
  operator: Operator;
  value?: T[keyof T] | T[keyof T][] | QueryBuilder<T> | null;
}

interface InternalCondition<T> extends Condition<T> {
  empty?: boolean;
}

export interface Aggregate<T> {
  function: AggregateFunction;
  field?: keyof T;
  resultProp?: string; // Prop name in the object returned from driver that contains the aggregate value
}

export interface Pagination {
  start: number;
  end: number;
}

export interface SortCriteria<T> {
  field: keyof T;
  desc?: boolean;
  byValues?: string[];
}

export class QueryBuilder<T = any> {
  public __serializerId = '@proteinjs/db/QueryBuilderSerializer';
  public graph: Graph;
  public idCounter: number = 0;
  public rootId: string = 'root';
  public currentContextIds: string[] = [];
  public paginationNodeId?: string;
  private debugLogicalGrouping = false;

  constructor(public tableName: string) {
    this.graph = new Graph({ directed: true });
    this.graph.setNode(this.rootId, { type: 'ROOT' });
  }

  private generateId(): string {
    return `node_${this.idCounter++}`;
  }

  /**
   * Creates a QueryBuilder instance from an object.
   * Object properties will be treated as fields, joined with AND to construct the query.
   * @param obj a query object
   * @param tableName the table to query
   * @returns a QueryBuilder with the query applied to it
   */
  static fromObject<T extends Object>(obj: Partial<T>, tableName: string): QueryBuilder<T> {
    const qb = new QueryBuilder<T>(tableName);
    for (const prop of Object.keys(obj)) {
      if (typeof obj[prop as keyof T] === 'undefined') {
        continue;
      }

      qb.condition({ field: prop as keyof T, operator: '=', value: obj[prop as keyof T] as T[keyof T] });
    }
    return qb;
  }

  select(select: Select<T>): this {
    const id = this.generateId();
    this.graph.setNode(id, { type: 'SELECT', ...select });
    this.graph.setEdge(this.rootId, id);
    return this;
  }

  /**
   * Adds a group of conditions or nested groups combined with the AND logical operator.
   * @param elements Array of Condition<T> or LogicalGroup<T> to be combined with AND.
   * @returns The instance of the QueryBuilder for chaining.
   */
  and(elements: Array<Condition<T> | LogicalGroup<T> | QueryBuilder<T>>): this {
    return this.logicalGroup('AND', elements);
  }

  /**
   * Adds a group of conditions or nested groups combined with the OR logical operator.
   * @param elements Array of Condition<T> or LogicalGroup<T> to be combined with OR.
   * @returns The instance of the QueryBuilder for chaining.
   */
  or(elements: Array<Condition<T> | LogicalGroup<T> | QueryBuilder<T>>): this {
    return this.logicalGroup('OR', elements);
  }

  /**
   * Adds a logical group of conditions or nested groups.
   * @param operator LogicalOperator ('AND' or 'OR').
   * @param elements Array of Condition<T> or LogicalGroup<T>.
   * @param parentId The ID of the parent node to attach the logical group to.
   * @returns The instance of the QueryBuilder for chaining.
   */
  logicalGroup(
    operator: LogicalOperator,
    elements: Array<Condition<T> | LogicalGroup<T> | QueryBuilder<T>>,
    parentId?: string
  ): this {
    const logger = new Logger(`${this.constructor.name}.logicalGroup`, this.debugLogicalGrouping ? 'debug' : 'info');
    const groupId = this.generateId();
    this.graph.setNode(groupId, { type: 'LOGICAL', operator });
    logger.debug(`Created node: ${operator} (${groupId})`);
    if (parentId) {
      this.graph.setEdge(parentId, groupId);
      logger.debug(`Set edge: ${parentId} -> ${groupId}`);
    } else {
      this.graph.setEdge(this.rootId, groupId);
      logger.debug(`Set edge: ${this.rootId} -> ${groupId}`);
    }

    const childIds: string[] = [];
    // Process each element in the provided array.
    elements.forEach((element) => {
      if (isInstanceOf(element, QueryBuilder)) {
        // Handling of QueryBuilder instances, assuming it's the same instance.
        if (this.currentContextIds.length > 0) {
          childIds.unshift(this.currentContextIds.pop() as string);
        }
      } else if ('operator' in element && 'children' in element) {
        // Recursively handle nested logical groups
        this.logicalGroup(element.operator, element.children, groupId);
      } else {
        // Handle adding a condition
        this.condition(element as Condition<T>, groupId);
      }
    });

    // Process linking child QueryBuilder nodes
    for (const childId of childIds) {
      this.graph.setEdge(groupId, childId);
      logger.debug(`Set edge: ${groupId} -> ${childId}`);
      if (this.graph.hasEdge(this.rootId, childId)) {
        this.graph.removeEdge(this.rootId, childId);
        logger.debug(`Removed edge: ${this.rootId} -> ${childId}`);
      }
    }

    this.currentContextIds.push(groupId);
    return this;
  }

  condition(condition: Condition<T>, parentId?: string): this {
    if (condition.value === this) {
      throw new Error(`Must use a new QueryBuilder instance for subquery`);
    }

    let resolvedCondition = condition;
    if (
      (Array.isArray(condition.value) && condition.value.length == 0) ||
      ((condition.operator === 'IN' || condition.operator === 'NOT IN') && !condition.value)
    ) {
      resolvedCondition = Object.assign(resolvedCondition, { empty: true }) as InternalCondition<T>;
    }

    if (typeof resolvedCondition.value === 'undefined') {
      resolvedCondition.value = null;
    }

    const logger = new Logger(`${this.constructor.name}.condition`, this.debugLogicalGrouping ? 'debug' : 'info');
    const conditionId = this.generateId();
    this.graph.setNode(conditionId, { ...resolvedCondition, type: 'CONDITION' });
    logger.debug(`Created node: CONDITION(${JSON.stringify(resolvedCondition)}) (${conditionId})`);
    if (parentId) {
      this.graph.setEdge(parentId, conditionId);
      logger.debug(`Set edge: ${parentId} -> ${conditionId}`);
    } else {
      this.graph.setEdge(this.rootId, conditionId);
      logger.debug(`Set edge: ${this.rootId} -> ${conditionId}`);
      this.currentContextIds.push(conditionId);
    }
    return this;
  }

  aggregate(aggregate: Aggregate<T>): this {
    const id = this.generateId();
    aggregate.field = aggregate.field ? aggregate.field : ('*' as keyof T);
    this.graph.setNode(id, { ...aggregate, type: 'AGGREGATE' });
    this.graph.setEdge(this.rootId, id);
    return this;
  }

  groupBy(fields: (keyof T)[]): this {
    const id = this.generateId();
    this.graph.setNode(id, { type: 'GROUP_BY', fields });
    this.graph.setEdge(this.rootId, id);
    return this;
  }

  paginate(pagination: Pagination): this {
    const paginationNodeExists = typeof this.paginationNodeId !== 'undefined';
    const id = this.paginationNodeId ? this.paginationNodeId : this.generateId();
    this.paginationNodeId = id;
    this.graph.setNode(id, { type: 'PAGINATION', ...pagination });
    if (!paginationNodeExists) {
      this.graph.setEdge(this.rootId, id);
    }
    return this;
  }

  sort(sortCriteria: SortCriteria<T>[]): this {
    sortCriteria.forEach((criteria) => {
      const id = this.generateId();
      this.graph.setNode(id, { type: 'SORT', criteria });
      this.graph.setEdge(this.rootId, id);
    });
    return this;
  }

  toWhereClause(config: StatementConfig, statementParamManager?: StatementParamManager): Statement {
    const paramManager = statementParamManager ? statementParamManager : new StatementParamManager(config);

    // Define a recursive function to process nodes and build condition strings
    const processNode = (nodeId: string): string => {
      const node: any = this.graph.node(nodeId);
      switch (node.type) {
        case 'CONDITION':
          const resolvedFieldName =
            node.field && config.resolveFieldName ? config.resolveFieldName(this.tableName, node.field) : node.field;
          if (node.empty) {
            return `1=0`;
          } else if (isInstanceOf(node.value, QueryBuilder)) {
            const valueStr = paramManager.parameterize(node.value, 'subquery');
            return `${resolvedFieldName} ${node.operator} ${valueStr}`;
          } else if (node.operator === 'IN' || node.operator === 'NOT IN') {
            const valuesStr = Array.isArray(node.value)
              ? node.value.map((val: any) => paramManager.parameterize(val, typeof val)).join(', ')
              : paramManager.parameterize(node.value, typeof node.value);
            return `${resolvedFieldName} ${node.operator} (${valuesStr})`;
          } else if (node.operator === 'BETWEEN') {
            // Ensure BETWEEN values are provided as an array of two elements
            const valuesStr = Array.isArray(node.value)
              ? node.value.map((val: any) => paramManager.parameterize(val, typeof val)).join(' AND ')
              : paramManager.parameterize(node.value, typeof node.value);
            return `${resolvedFieldName} ${node.operator} ${valuesStr}`;
          } else if (node.operator === 'IS NULL' || node.operator === 'IS NOT NULL') {
            return `${resolvedFieldName} ${node.operator}`;
          } else {
            const conditionValue = paramManager.parameterize(node.value, typeof node.value);
            return `${resolvedFieldName} ${node.operator} ${conditionValue}`;
          }
        case 'LOGICAL':
          const childIds: string[] = this.graph.successors(nodeId) || [];
          const childConditions: string[] = childIds.map(processNode).filter((cond) => cond !== '');
          const combinedConditions = childConditions.join(` ${node.operator} `);
          return combinedConditions ? `(${combinedConditions})` : '';
        default:
          return '';
      }
    };

    // Start processing from the root node
    const rootChildren: string[] = this.graph.successors(this.rootId) || [];
    const whereParts = rootChildren.map(processNode).filter((part) => part.length > 0);
    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    return { sql: whereClause, ...paramManager.getParams() };
  }

  toSql(config: StatementConfig): Statement {
    let select: Select<any> | undefined;
    const aggregates: string[] = [];
    const groupBys: string[] = [];
    let pagination: Pagination | undefined;
    const sortClauses: string[] = [];
    const paramManager = new StatementParamManager(config);

    // Define a recursive function to process nodes and statement parts
    const processNode = (nodeId: string): string => {
      const node: any = this.graph.node(nodeId);
      switch (node.type) {
        case 'SELECT':
          select = node;
          return '';
        case 'AGGREGATE':
          const resolvedAggFieldName =
            config.resolveFieldName && node.field != '*'
              ? config.resolveFieldName(this.tableName, node.field)
              : node.field;
          aggregates.push(
            `${node.function}(${resolvedAggFieldName})${node.resultProp ? ` as ${node.resultProp}` : ''}`
          );
          return '';
        case 'GROUP_BY':
          groupBys.push(
            ...node.fields.map((field: keyof T) =>
              config.resolveFieldName ? config.resolveFieldName(this.tableName, String(field)) : String(field)
            )
          );
          return '';
        case 'PAGINATION':
          pagination = { start: node.start, end: node.end };
          return '';
        case 'SORT':
          const { field, desc, byValues } = node.criteria;
          const resolvedSortFieldName = config.resolveFieldName
            ? config.resolveFieldName(this.tableName, field)
            : field;
          if (byValues && byValues.length > 0) {
            // Constructing a CASE statement for sorting by specific values
            const cases = byValues
              .map(
                (value: string, index: number) =>
                  `WHEN ${resolvedSortFieldName} = ${paramManager.parameterize(value, typeof value)} THEN ${index}`
              )
              .join(' ');
            const orderByCase = `CASE ${cases} ELSE ${byValues.length} END`;
            sortClauses.push(`${orderByCase}${desc ? ' DESC' : ' ASC'}`);
          } else {
            // Standard sorting
            const sortClause = `${resolvedSortFieldName}${desc ? ' DESC' : ' ASC'}`;
            sortClauses.push(sortClause);
          }
          return '';
        default:
          return '';
      }
    };

    // Start processing from the root node
    const rootChildren: string[] = this.graph.successors(this.rootId) || [];

    // order dependent for parameter value sequencing in paramManager.params
    const { sql: whereClause } = this.toWhereClause(config, paramManager);
    rootChildren.map(processNode).filter((part) => part.length > 0);
    // order dependent for parameter value sequencing in paramManager.params

    let sql = 'SELECT ';
    sql += aggregates.length > 0 ? aggregates.join(', ') : select?.fields ? select.fields.join(', ') : '*';
    sql += ` FROM ${config.dbName ? `${config.dbName}.` : ''}${this.tableName}`;

    if (whereClause.length > 0) {
      sql += ` ${whereClause}`;
    }

    if (groupBys.length > 0) {
      sql += ` GROUP BY ${groupBys.join(', ')}`;
    }

    if (sortClauses.length > 0) {
      sql += ` ORDER BY ${sortClauses.join(', ')}`;
    }

    if (pagination) {
      const limit = pagination.end - pagination.start;
      const offset = pagination.start;
      sql += ` LIMIT ${limit} OFFSET ${offset}`;
    }

    sql = sql.trim() + ';';
    return { sql, ...paramManager.getParams() };
  }
}
