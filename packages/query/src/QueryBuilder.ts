import { Logger } from '@proteinjs/logger';
import { Graph, isInstanceOf } from '@proteinjs/util';
import { Serializer } from '@proteinjs/serializer';
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
  value?: T[keyof T] | T[keyof T][] | QueryBuilder | null;
}

interface InternalCondition<T> extends Condition<T> {
  empty?: boolean;
}

export interface Aggregate<T> {
  function: AggregateFunction;
  field?: keyof T;
  resultProp?: string; // Prop name in the object returned from driver that contains the aggregate value
}

/**
 * A time-bucketed GROUP BY dimension: the datetime column truncated to the bucket unit, selected
 * under `resultProp` and grouped on, so aggregate rows come back per bucket (e.g. per UTC day).
 * Requires a driver that supplies `StatementConfig.dateTruncExpression` (drivers without one fail
 * loudly at statement generation — a silent full-table group would be a wrong answer, not a
 * degraded one). Two units exist: 'day' and 'hour'. Coarser buckets than a day (week/month/year)
 * are honest folds of day rows in application code; 'hour' is a genuine SQL grain because you
 * cannot recover it from day rows, and finer than the atomic ledger row is meaningless — so every
 * driver supplies exactly these two truncations. Both truncate in UTC (the Spanner driver
 * unconditionally); hour-grain callers render the UTC buckets in the operator's local time.
 */
export interface TimeBucket<T> {
  field: keyof T;
  unit: 'day' | 'hour';
  resultProp: string; // Prop name in the object returned from the driver that contains the bucket start
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
      qb.condition({ field: prop as keyof T, operator: '=', value: obj[prop as keyof T] as T[keyof T] });
    }
    return qb;
  }

  /**
   * Creates a new QueryBuilder instance from an existing QueryBuilder.
   * Sets all properties of the QueryBuilder class.
   * @param qb an existing query builder
   * @param tableName the table to query
   * @returns a new QueryBuilder instance
   */
  static fromQueryBuilder<T = any>(qb: QueryBuilder<T>, tableName: string): QueryBuilder<T> {
    return Serializer.deserialize(Serializer.serialize(qb));
  }

  private generateId(): string {
    return `node_${this.idCounter++}`;
  }

  /**
   * This function retrieves the column type specific to the database driver's configuration.
   * If no function is provided by the driver to retrieve the column type, then the type will be determined using `typeof value`.
   *
   * @param {StatementConfig} config The configuration object containing the database driver and other settings.
   * @param {string} columnPropertyName The property name of the column for which the type is being retrieved.
   * @param {any} value The value that will be stored in the column, used to infer the type if necessary.
   * @returns {string} The column type specific to the database driver, or `typeof value` if the column type was not found.
   */
  private getDriverColumnType = (config: StatementConfig, columnPropertyName: string, value: any): string => {
    const logger = new Logger({ name: 'QueryBuilder.getDriverColumnType' });
    try {
      const columnName = config.resolveFieldName
        ? config.resolveFieldName(this.tableName, columnPropertyName)
        : columnPropertyName;
      return config.getDriverColumnType ? config.getDriverColumnType(this.tableName, columnName) : typeof value;
    } catch (error: any) {
      logger.debug({
        message: `Failed to get driver's column type for ${this.tableName}.${columnPropertyName}`,
        obj: { error },
      });
      return typeof value;
    }
  };

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
    const logger = new Logger({
      name: `${this.constructor.name}.logicalGroup`,
      logLevel: this.debugLogicalGrouping ? 'debug' : 'info',
    });
    const groupId = this.generateId();
    this.graph.setNode(groupId, { type: 'LOGICAL', operator });
    logger.debug({ message: `Created node: ${operator} (${groupId})` });
    if (parentId) {
      this.graph.setEdge(parentId, groupId);
      logger.debug({ message: `Set edge: ${parentId} -> ${groupId}` });
    } else {
      this.graph.setEdge(this.rootId, groupId);
      logger.debug({ message: `Set edge: ${this.rootId} -> ${groupId}` });
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
      logger.debug({ message: `Set edge: ${groupId} -> ${childId}` });
      if (this.graph.hasEdge(this.rootId, childId)) {
        this.graph.removeEdge(this.rootId, childId);
        logger.debug({ message: `Removed edge: ${this.rootId} -> ${childId}` });
      }
    }

    this.currentContextIds.push(groupId);
    return this;
  }

  /**
   * Builds a condition.
   * @param condition Condition object, contains field, operator, and optional value.
   * @param parentId Used to set the condition's parent.
   * @param caseSensitive Used only for querying a string column. Defaults to true.
   * @returns
   */
  condition(condition: Condition<T>, parentId?: string, caseSensitive: boolean = true): this {
    if (condition.value === this) {
      throw new Error(`Must use a new QueryBuilder instance for subquery`);
    }

    let resolvedCondition = condition;
    if (
      (Array.isArray(condition.value) && condition.value.length == 0) ||
      ((condition.operator === 'IN' || condition.operator === 'NOT IN') && !condition.value)
    ) {
      resolvedCondition = Object.assign(resolvedCondition, { value: null, empty: true }) as InternalCondition<T>;
    }

    if (typeof resolvedCondition.value === 'undefined') {
      if (condition.operator !== 'IS NULL' && condition.operator !== 'IS NOT NULL') {
        throw new Error(
          `Must not pass in undefined for value in condition. Undefined was found when checking value property in this condition: ${JSON.stringify(condition)}`
        );
      }
      resolvedCondition.value = null;
    }

    resolvedCondition = Object.assign(resolvedCondition, { caseSensitive }) as InternalCondition<T>;

    const logger = new Logger({
      name: `${this.constructor.name}.condition`,
      logLevel: this.debugLogicalGrouping ? 'debug' : 'info',
    });
    const conditionId = this.generateId();
    this.graph.setNode(conditionId, { ...resolvedCondition, type: 'CONDITION' });
    logger.debug({
      message: `Created condition node`,
      obj: { condition: resolvedCondition, conditionId },
    });
    if (parentId) {
      this.graph.setEdge(parentId, conditionId);
      logger.debug({ message: `Set edge: ${parentId} -> ${conditionId}` });
    } else {
      this.graph.setEdge(this.rootId, conditionId);
      logger.debug({ message: `Set edge: ${this.rootId} -> ${conditionId}` });
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

  /** Add a time-bucketed GROUP BY dimension (see {@link TimeBucket}). */
  timeBucket(bucket: TimeBucket<T>): this {
    const id = this.generateId();
    this.graph.setNode(id, { ...bucket, type: 'TIME_BUCKET' });
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

  /** Read the sort criteria applied to this query, in the order `toSql` renders them. */
  getSortCriteria(): SortCriteria<T>[] {
    return this.sortNodeIds().map((id) => (this.graph.node(id) as any).criteria as SortCriteria<T>);
  }

  /**
   * Remove every sort criterion from this query and return them (in `toSql` render order).
   * Lets a pager take ordering over from a consumer-built query: cursor windows must own the
   * ORDER BY (the cursor axes and the sort have to agree), so they lift the consumer's
   * criteria off the base query and re-apply them per window alongside the cursor conditions.
   */
  removeSortCriteria(): SortCriteria<T>[] {
    const criteria: SortCriteria<T>[] = [];
    for (const id of this.sortNodeIds()) {
      criteria.push((this.graph.node(id) as any).criteria as SortCriteria<T>);
      this.graph.removeNode(id);
    }
    return criteria;
  }

  private sortNodeIds(): string[] {
    const rootChildren: string[] = this.graph.successors(this.rootId) || [];
    return rootChildren.filter((id) => (this.graph.node(id) as any)?.type === 'SORT');
  }

  toWhereClause(config: StatementConfig, statementParamManager?: StatementParamManager): Statement {
    const paramManager = statementParamManager ? statementParamManager : new StatementParamManager(config);

    // Define a recursive function to process nodes and build condition strings
    const processNode = (nodeId: string): string => {
      const node: any = this.graph.node(nodeId);
      switch (node.type) {
        case 'CONDITION': {
          const resolvedFieldName =
            node.field && config.resolveFieldName ? config.resolveFieldName(this.tableName, node.field) : node.field;

          const fieldNameWithBackticks = `\`${resolvedFieldName}\``;
          let processedFieldName = fieldNameWithBackticks;
          let processedValue = node.value;
          // case sensitivity can only be handled if the field name is resolved
          if (config.resolveFieldName && config.handleCaseSensitivity) {
            processedFieldName = config.handleCaseSensitivity(this.tableName, resolvedFieldName, node.caseSensitive);
            processedFieldName = processedFieldName.replace(resolvedFieldName, fieldNameWithBackticks);
            if (!node.caseSensitive) {
              if (Array.isArray(node.value)) {
                processedValue = node.value.map((item: any) => (typeof item === 'string' ? item.toLowerCase() : item));
              } else if (typeof node.value === 'string') {
                processedValue = node.value.toLowerCase();
              }
            }
          }

          if (node.empty) {
            return `1=0`;
          } else if (isInstanceOf(processedValue, QueryBuilder)) {
            const valueStr = paramManager.parameterize(processedValue, 'subquery');
            return `${processedFieldName} ${node.operator} ${valueStr}`;
          } else if (node.operator === 'IN' || node.operator === 'NOT IN') {
            if (config.useNamedParams) {
              const valuesStr = Array.isArray(processedValue)
                ? paramManager.parameterize(
                    processedValue,
                    this.getDriverColumnType(config, node.field, processedValue[0])
                  )
                : paramManager.parameterize(
                    processedValue,
                    this.getDriverColumnType(config, node.field, processedValue)
                  );
              return `${processedFieldName} ${node.operator} UNNEST(${valuesStr})`;
            }
            const valuesStr = Array.isArray(processedValue)
              ? processedValue.map((val: any) => paramManager.parameterize(val, typeof val)).join(', ')
              : paramManager.parameterize(processedValue, typeof processedValue);
            return `${processedFieldName} ${node.operator} (${valuesStr})`;
          } else if (node.operator === 'BETWEEN') {
            // Ensure BETWEEN values are provided as an array of two elements
            const valuesStr = Array.isArray(processedValue)
              ? processedValue
                  .map((val: any) => paramManager.parameterize(val, this.getDriverColumnType(config, node.field, val)))
                  .join(' AND ')
              : paramManager.parameterize(processedValue, this.getDriverColumnType(config, node.field, processedValue));
            return `${processedFieldName} ${node.operator} ${valuesStr}`;
          } else if (node.operator === 'IS NULL' || node.operator === 'IS NOT NULL') {
            return `${processedFieldName} ${node.operator}`;
          } else {
            if (processedValue === null) {
              return `${processedFieldName} IS NULL`;
            }

            const conditionValue = paramManager.parameterize(
              processedValue,
              this.getDriverColumnType(config, node.field, processedValue)
            );
            return `${processedFieldName} ${node.operator} ${conditionValue}`;
          }
        }
        case 'LOGICAL': {
          const childIds: string[] = this.graph.successors(nodeId) || [];
          const childConditions: string[] = childIds.map(processNode).filter((cond) => cond !== '');
          const combinedConditions = childConditions.join(` ${node.operator} `);
          return combinedConditions ? `(${combinedConditions})` : '';
        }
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
    const bucketSelects: string[] = [];
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
        case 'AGGREGATE': {
          const resolvedAggFieldName =
            node.field === '*'
              ? '*'
              : config.resolveFieldName
                ? `\`${config.resolveFieldName(this.tableName, node.field)}\``
                : `\`${node.field}\``;
          aggregates.push(
            `${node.function}(${resolvedAggFieldName})${node.resultProp ? ` as ${node.resultProp}` : ''}`
          );
          return '';
        }
        case 'GROUP_BY': {
          groupBys.push(
            ...node.fields.map((field: keyof T) =>
              config.resolveFieldName
                ? `\`${config.resolveFieldName(this.tableName, String(field))}\``
                : `\`${String(field)}\``
            )
          );
          return '';
        }
        case 'TIME_BUCKET': {
          if (!config.dateTruncExpression) {
            throw new Error(
              `Query on ${this.tableName} uses timeBucket('${node.unit}'), but the driver's statement config provides no dateTruncExpression`
            );
          }
          const resolvedBucketFieldName = config.resolveFieldName
            ? `\`${config.resolveFieldName(this.tableName, String(node.field))}\``
            : `\`${String(node.field)}\``;
          const bucketExpression = config.dateTruncExpression(resolvedBucketFieldName, node.unit);
          bucketSelects.push(`${bucketExpression} as ${node.resultProp}`);
          // Group on the expression (not the alias) — valid in both GoogleSQL and MySQL.
          groupBys.push(bucketExpression);
          return '';
        }
        case 'PAGINATION':
          pagination = { start: node.start, end: node.end };
          return '';
        case 'SORT': {
          const { field, desc, byValues } = node.criteria;
          const resolvedSortFieldName = config.resolveFieldName
            ? `\`${config.resolveFieldName(this.tableName, field)}\``
            : `\`${field}\``;
          if (byValues && byValues.length > 0) {
            // Constructing a CASE statement for sorting by specific values
            const cases = byValues
              .map(
                (value: string, index: number) =>
                  `WHEN ${resolvedSortFieldName} = ${paramManager.parameterize(value, this.getDriverColumnType(config, node.field, value))} THEN ${index}`
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
        }
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
    // Plain fields, time-bucket expressions, and aggregates COMPOSE in one select list —
    // `SELECT model, SUM(tokens) as t ... GROUP BY model` is the grouped-aggregation shape.
    // (Previously select fields silently DROPPED any aggregates; nothing depended on that.)
    const selectParts: string[] = [];
    if (select?.fields) {
      selectParts.push(
        ...select.fields.map((field) => {
          const col = config.resolveFieldName ? config.resolveFieldName(this.tableName, String(field)) : String(field);
          return `\`${col}\``;
        })
      );
    }
    selectParts.push(...bucketSelects, ...aggregates);
    sql += selectParts.length > 0 ? selectParts.join(', ') : '*';
    sql += ` FROM ${config.dbName ? `\`${config.dbName}\`.` : ''}\`${this.tableName}\``;

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
