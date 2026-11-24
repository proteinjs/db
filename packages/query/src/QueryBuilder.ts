import { Logger } from '@proteinjs/logger';
import { Graph, isInstanceOf } from '@proteinjs/util';
import { Serializer } from '@proteinjs/serializer';
import { Statement, StatementConfig, StatementParamManager } from './StatementFactory';
import { ColumnQueryTransformProvider } from './ColumnQueryTransform';

export interface Select<T> {
  fields?: (keyof T)[];
}

/**
 * The words of the query language that a statement holds as text. Each list is declared once and read
 * three times: by its type, by the writer ({@link QueryBuilder.toSql}, {@link QueryBuilder.toWhereClause})
 * and by the rebuild of a builder read from a text ({@link QueryBuilder.rebuiltFrom}).
 */
export const LOGICAL_OPERATORS = ['AND', 'OR'] as const;
export type LogicalOperator = (typeof LOGICAL_OPERATORS)[number];
export const OPERATORS = [
  '=',
  '<>',
  '!=',
  '>',
  '<',
  '>=',
  '<=',
  'IN',
  'NOT IN',
  'LIKE',
  'NOT LIKE',
  'BETWEEN',
  'IS NULL',
  'IS NOT NULL',
  'NOT',
] as const;
export type Operator = (typeof OPERATORS)[number];
export const AGGREGATE_FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'] as const;
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number];
export const TIME_BUCKET_UNITS = ['day', 'hour', 'minute'] as const;
export type TimeBucketUnit = (typeof TIME_BUCKET_UNITS)[number];

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
 * degraded one). Three units exist: 'day', 'hour', and 'minute'. Coarser buckets than a day
 * (week/month/year) are honest folds of day rows in application code; 'hour' and 'minute' are
 * genuine SQL grains because you cannot recover them from coarser rows, and finer than the atomic
 * ledger row is meaningless — so every driver supplies exactly these truncations ('minute' is the
 * floor: sub-minute buckets need a non-TRUNC bucket expression, deliberately not built). All
 * truncate in UTC (the Spanner driver unconditionally); hour/minute-grain callers render the UTC
 * buckets in the operator's local time.
 */
export interface TimeBucket<T> {
  field: keyof T;
  unit: TimeBucketUnit;
  resultProp: string; // Prop name in the object returned from the driver that contains the bucket start
}

export interface Pagination {
  start: number;
  end: number;
}

export interface SortCriteria<T> {
  field: keyof T;
  desc?: boolean;
  /**
   * Order by these values of `field`, in this order, every other row after them (a `CASE … END`
   * ordering). The values are the column's own — a boolean column's `[true]`, an integer column's
   * `[3, 1]` — and each binds with the column's driver type.
   */
  byValues?: T[keyof T][];
}

/**
 * Where a builder keeps the mark that it was read from a text (see {@link QueryBuilder.wasReadFromText}).
 * A plain name, so every copy of this package loaded into one process reads the same mark.
 */
const READ_FROM_TEXT = '__readFromText';

export class QueryBuilder<T = any> {
  public __serializerId = '@proteinjs/db/QueryBuilderSerializer';
  public graph: Graph;
  public idCounter: number = 0;
  public rootId: string = 'root';
  public currentContextIds: string[] = [];
  public paginationNodeId?: string;
  /** Set once {@link applyColumnTransforms} has run — the phase applies once per builder. */
  public columnTransformsApplied = false;
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
    const copy: QueryBuilder<T> = Serializer.deserialize(Serializer.serialize(qb));
    QueryBuilder.seatOrigin(qb, copy);
    return copy;
  }

  /**
   * The running code's own builder of the query that a builder read from a text describes.
   *
   * A builder read from a text is a description of a query: which rows of its table, in what order, how
   * many. It is not run as it came, and nothing is added to it. This makes a new builder and writes the
   * description into it part by part: from the root, each part once, each part of a kind this class
   * makes, each field of a part of the type that kind holds, each word one the language declares. What a
   * description holds beyond that is not carried over, its numbering and its list of contexts included:
   * the new builder numbers its own parts and has chained nothing yet.
   *
   * A query inside the description is rebuilt the same way and handed to `eachQueryWithin`: it is a
   * query of a table of its own, and whoever runs the whole asks that table about it. A query the
   * running code itself put inside a builder it was handed stays as it is.
   *
   * Throws when the description is not one this class could have written.
   */
  static rebuiltFrom<T = any>(
    read: QueryBuilder<T>,
    eachQueryWithin: (query: QueryBuilder<any>) => void
  ): QueryBuilder<T> {
    const description: any = read;
    const graph: any = description?.graph;
    let written = false;
    try {
      written =
        typeof description.tableName === 'string' &&
        description.tableName.length > 0 &&
        description.rootId === 'root' &&
        graph.isDirected() === true;
    } catch {
      written = false;
    }
    if (!written) {
      throw QueryBuilder.notAQuery('it is not a description this builder writes');
    }

    const rebuilt = new QueryBuilder<T>(description.tableName);
    const rebuiltOnce: { [id: string]: true } = Object.create(null);
    const rebuildPartsOf = (parentId: string, rebuiltParentId: string, inAGroup: boolean): void => {
      const partIds: unknown = graph.successors(parentId);
      for (const partId of Array.isArray(partIds) ? partIds : []) {
        if (partId in rebuiltOnce) {
          throw QueryBuilder.notAQuery('a part of it is held twice');
        }

        const part = QueryBuilder.rebuiltPart(graph.node(partId), inAGroup, eachQueryWithin);
        const rebuiltId = rebuilt.generateId();
        rebuiltOnce[partId] = true;
        rebuilt.graph.setNode(rebuiltId, part);
        rebuilt.graph.setEdge(rebuiltParentId, rebuiltId);
        if (part.type === 'LOGICAL') {
          rebuildPartsOf(partId, rebuiltId, true);
        } else if (part.type === 'PAGINATION') {
          rebuilt.paginationNodeId = rebuiltId;
        }
      }
    };
    rebuildPartsOf('root', rebuilt.rootId, false);
    return rebuilt;
  }

  /**
   * Whether this builder says which rows and nothing else: every part under its root is a condition or a
   * group. An update or a delete is run from such a query. A select, an aggregate, a group-by, a time
   * bucket, a sort and a page say what a read answers; they are no part of which rows a write reaches.
   */
  saysOnlyWhichRows(): boolean {
    const parts: string[] = this.graph.successors(this.rootId) || [];
    return parts.every((id) => {
      const type = (this.graph.node(id) as { type?: unknown } | undefined)?.type;
      return type === 'CONDITION' || type === 'LOGICAL';
    });
  }

  /**
   * Whether a builder is one the running code made: it keeps the mark of where it came from (a builder of
   * this class does) and was not read from a text. A statement holds a query inside it only from such a
   * builder ({@link StatementParamManager.parameterize}): a query inside a query is written, not bound, and
   * reads a table of its own.
   */
  static isTheCodesOwn(qb: unknown): boolean {
    const builder = qb as { wasReadFromText?: unknown } | null | undefined;
    return typeof builder?.wasReadFromText === 'function' && !(qb as QueryBuilder).wasReadFromText();
  }

  /**
   * Whether this builder was read from a text, as against made by the running code. Its serializer says so
   * as it makes one ({@link markReadFromText}), and the copy the code makes of a builder it holds
   * ({@link fromQueryBuilder}) says of each builder what its source says. The mark is not a field of a
   * builder's form: a text never carries it.
   */
  wasReadFromText(): boolean {
    return READ_FROM_TEXT in this;
  }

  /** Marks this builder as read from a text. Whatever makes a builder from a text calls it. */
  markReadFromText(): this {
    Object.defineProperty(this, READ_FROM_TEXT, { value: true, enumerable: false, configurable: true });
    return this;
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

    const resolvedCondition = this.normalizeCondition(condition, caseSensitive);

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

  /**
   * Shared normalization for caller-built conditions and transform-produced replacements
   * ({@link applyColumnTransforms}): empty IN sets become an empty-set condition (renders
   * `1=0`), undefined values fail loudly, and the case-sensitivity flag is stamped.
   */
  private normalizeCondition(condition: Condition<T>, caseSensitive: boolean): InternalCondition<T> {
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

    return Object.assign(resolvedCondition, { caseSensitive }) as InternalCondition<T>;
  }

  /**
   * The column-transform phase of the query model: build → APPLY COLUMN TRANSFORMS →
   * render. Consults each column's `ColumnQueryTransform` (via `provider`) for every use
   * of the column in this query — conditions (including inside subquery values, which are
   * transformed recursively), ORDER BY criteria, aggregations, and GROUP BY fields — and
   * splices the returned replacements into the graph in place. A transform that cannot
   * serve a use throws its contract error here, at query-build time.
   *
   * Runs where statements are generated (the server): transforms may consult derived
   * index state, which is why this is a distinct async phase rather than part of the
   * sync, wire-portable builder API. Applies exactly once per builder instance;
   * replacement conditions go through the same normalization as caller-built ones and
   * compare case-sensitively (they target derived artifacts, not caller text).
   */
  async applyColumnTransforms(provider: ColumnQueryTransformProvider): Promise<void> {
    if (this.columnTransformsApplied) {
      return;
    }

    for (const nodeId of this.graph.nodes().slice()) {
      const node: any = this.graph.node(nodeId);
      if (!node) {
        continue;
      }

      switch (node.type) {
        case 'CONDITION': {
          // A query inside this one that the running code made. One read from a text is not walked into:
          // no statement is written from it either.
          if (isInstanceOf(node.value, QueryBuilder) && QueryBuilder.isTheCodesOwn(node.value)) {
            await (node.value as QueryBuilder<any>).applyColumnTransforms(provider);
          }
          const transform = provider.getTransform(this.tableName, node.field);
          if (!transform?.transformCondition) {
            break;
          }
          const replacement = await transform.transformCondition(
            { field: node.field, operator: node.operator, value: node.value },
            { caseSensitive: node.caseSensitive !== false }
          );
          if (!replacement) {
            break;
          }
          if (this.isLogicalGroup(replacement)) {
            this.replaceNodeWithGroup(nodeId, replacement as LogicalGroup<T>);
          } else {
            this.graph.setNode(nodeId, {
              ...this.normalizeCondition({ ...(replacement as Condition<T>) }, true),
              type: 'CONDITION',
            });
          }
          break;
        }
        case 'SORT': {
          const transform = provider.getTransform(this.tableName, node.criteria?.field);
          const replacement = transform?.transformSort?.({ ...node.criteria });
          if (replacement) {
            node.criteria = replacement;
          }
          break;
        }
        case 'AGGREGATE': {
          const transform = provider.getTransform(this.tableName, node.field);
          const replacement = transform?.transformAggregate?.({
            function: node.function,
            field: node.field,
            resultProp: node.resultProp,
          });
          if (replacement) {
            this.graph.setNode(nodeId, { ...replacement, type: 'AGGREGATE' });
          }
          break;
        }
        case 'GROUP_BY': {
          node.fields = (node.fields || []).map(
            (field: string) => provider.getTransform(this.tableName, field)?.transformGroupByField?.(field) ?? field
          );
          break;
        }
      }
    }

    // Marked only after full success: a contract rejection above must re-reject on a
    // retried application, never silently skip enforcement. Partial application is safe to
    // retry — replacements target derived/id fields, which carry no transforms of their own.
    this.columnTransformsApplied = true;
  }

  /** Populate `nodeId` as a LOGICAL group with fresh child nodes (transform replacements). */
  private replaceNodeWithGroup(nodeId: string, group: LogicalGroup<T>): void {
    this.graph.setNode(nodeId, { type: 'LOGICAL', operator: group.operator });
    for (const child of group.children) {
      const childId = this.generateId();
      if (this.isLogicalGroup(child)) {
        this.replaceNodeWithGroup(childId, child);
      } else {
        this.graph.setNode(childId, {
          ...this.normalizeCondition({ ...(child as Condition<T>) }, true),
          type: 'CONDITION',
        });
      }
      this.graph.setEdge(nodeId, childId);
    }
  }

  private isLogicalGroup(value: Condition<any> | LogicalGroup<any>): value is LogicalGroup<any> {
    return 'children' in value && 'operator' in value && Array.isArray((value as LogicalGroup<T>).children);
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
    QueryBuilder.theCodesOwnToWrite(this);
    const paramManager = statementParamManager ? statementParamManager : new StatementParamManager(config);

    // Define a recursive function to process nodes and build condition strings
    const processNode = (nodeId: string): string => {
      const node: any = this.graph.node(nodeId);
      switch (node.type) {
        case 'CONDITION': {
          QueryBuilder.word(node.operator, OPERATORS, `a condition's operator`);
          const resolvedFieldName =
            node.field && config.resolveFieldName ? config.resolveFieldName(this.tableName, node.field) : node.field;

          const fieldNameWithBackticks = QueryBuilder.quoted(resolvedFieldName);
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
          const logicalOperator = QueryBuilder.word(node.operator, LOGICAL_OPERATORS, 'a logical operator');
          const combinedConditions = childConditions.join(` ${logicalOperator} `);
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
          const aggregateFunction = QueryBuilder.word(node.function, AGGREGATE_FUNCTIONS, 'an aggregate function');
          const resultName = node.resultProp
            ? QueryBuilder.resultName(node.resultProp, `an aggregate's result name`)
            : '';
          const resolvedAggFieldName =
            node.field === '*'
              ? '*'
              : QueryBuilder.quoted(
                  config.resolveFieldName ? config.resolveFieldName(this.tableName, node.field) : node.field
                );
          aggregates.push(`${aggregateFunction}(${resolvedAggFieldName})${resultName ? ` as ${resultName}` : ''}`);
          return '';
        }
        case 'GROUP_BY': {
          groupBys.push(
            ...QueryBuilder.list<keyof T>(node.fields, `a group-by's fields`).map((field) =>
              QueryBuilder.quoted(
                config.resolveFieldName ? config.resolveFieldName(this.tableName, String(field)) : String(field)
              )
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
          const unit = QueryBuilder.word(node.unit, TIME_BUCKET_UNITS, `a time bucket's unit`);
          const resultName = QueryBuilder.resultName(node.resultProp, `a time bucket's result name`);
          const resolvedBucketFieldName = QueryBuilder.quoted(
            config.resolveFieldName ? config.resolveFieldName(this.tableName, String(node.field)) : String(node.field)
          );
          const bucketExpression = config.dateTruncExpression(resolvedBucketFieldName, unit);
          bucketSelects.push(`${bucketExpression} as ${resultName}`);
          // Group on the expression (not the alias) — valid in both GoogleSQL and MySQL.
          groupBys.push(bucketExpression);
          return '';
        }
        case 'PAGINATION':
          pagination = QueryBuilder.page(node);
          return '';
        case 'SORT': {
          const { field, desc, byValues } = node.criteria;
          const resolvedSortFieldName = QueryBuilder.quoted(
            config.resolveFieldName ? config.resolveFieldName(this.tableName, field) : field
          );
          if (byValues && QueryBuilder.list(byValues, `a sort's values`).length > 0) {
            // A CASE ordering over the sorted column. Each value binds with the COLUMN's driver
            // type (a SORT node keeps its field on `criteria`, so the lookup goes by `field` —
            // typing by the value's own shape leaves a BOOL or INT64 column's parameter without a
            // type code and the driver refuses the statement).
            const cases = byValues
              .map(
                (value: T[keyof T], index: number) =>
                  `WHEN ${resolvedSortFieldName} = ${paramManager.parameterize(value, this.getDriverColumnType(config, field, value))} THEN ${index}`
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
        ...QueryBuilder.list<keyof any>(select.fields, `a select's fields`).map((field) => {
          const col = config.resolveFieldName ? config.resolveFieldName(this.tableName, String(field)) : String(field);
          return QueryBuilder.quoted(col);
        })
      );
    }
    selectParts.push(...bucketSelects, ...aggregates);
    sql += selectParts.length > 0 ? selectParts.join(', ') : '*';
    sql += ` FROM ${config.dbName ? `${QueryBuilder.quoted(config.dbName)}.` : ''}${QueryBuilder.quoted(this.tableName)}`;

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

  /** A word that is set into a statement as text: one the language declares. */
  private static word<W extends string>(word: unknown, declared: readonly W[], kind: string): W {
    if (typeof word !== 'string' || (declared as readonly string[]).indexOf(word) === -1) {
      throw new Error(
        `QueryBuilder: ${kind} is not one the query language holds (${declared.join(', ')}) — no statement was written`
      );
    }

    return word as W;
  }

  /** The name a result is selected under, written as text: a plain name, or no statement is written. */
  private static resultName(name: unknown, kind: string): string {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`QueryBuilder: ${kind} is not a plain name — no statement was written`);
    }

    return name;
  }

  /**
   * A name the writer quotes (a table, a column): the name between quotes. It holds no quote itself, and
   * no backslash: between quotes a backslash begins an escape in some of the languages a driver writes.
   */
  private static quoted(name: unknown): string {
    const text = String(name);
    if (text.indexOf('`') !== -1 || text.indexOf('\\') !== -1) {
      throw new Error(
        `QueryBuilder: a name a statement quotes holds a quote or a backslash — no statement was written`
      );
    }

    return `\`${text}\``;
  }

  /** A list the writer walks: a list. */
  private static list<V = unknown>(value: unknown, kind: string): V[] {
    if (!Array.isArray(value)) {
      throw new Error(`QueryBuilder: ${kind} are not a list — no statement was written`);
    }

    return value;
  }

  /** A statement is written from a builder the running code made (see {@link isTheCodesOwn}, {@link rebuiltFrom}). */
  private static theCodesOwnToWrite(qb: QueryBuilder<any>): void {
    if (!QueryBuilder.isTheCodesOwn(qb)) {
      throw new Error(
        `QueryBuilder: a builder read from a text is rebuilt before a statement is written from it — no statement was written`
      );
    }
  }

  private static notAQuery(why: string): Error {
    return new Error(`QueryBuilder: a builder read from a text is not rebuilt: ${why} — no query was built`);
  }

  /**
   * One part of a description (see {@link rebuiltFrom}), rebuilt: a new label holding the fields its kind
   * holds, each of its type. A field is read only when the part holds it as its own.
   */
  private static rebuiltPart(
    description: any,
    inAGroup: boolean,
    eachQueryWithin: (query: QueryBuilder<any>) => void
  ): { type: string; [field: string]: any } {
    const own = (holder: any, field: string): unknown =>
      holder !== null && typeof holder === 'object' && Object.prototype.hasOwnProperty.call(holder, field)
        ? holder[field]
        : undefined;
    const text = (value: unknown, kind: string): string => {
      if (typeof value !== 'string') {
        throw QueryBuilder.notAQuery(`${kind} is not text`);
      }

      return value;
    };
    const texts = (value: unknown, kind: string): string[] =>
      QueryBuilder.listOfADescription(value, kind).map((item) => text(item, kind));
    const value = (item: unknown): unknown => {
      if (!isInstanceOf(item, QueryBuilder) || QueryBuilder.isTheCodesOwn(item)) {
        return item;
      }

      const within = QueryBuilder.rebuiltFrom(item as QueryBuilder<any>, eachQueryWithin);
      eachQueryWithin(within);
      return within;
    };
    const values = (item: unknown): unknown =>
      Array.isArray(item) ? QueryBuilder.listOfADescription(item, `a condition's values`).map(value) : value(item);

    const type = own(description, 'type');
    if (inAGroup && type !== 'CONDITION' && type !== 'LOGICAL') {
      throw QueryBuilder.notAQuery('a group holds a part that is neither a condition nor a group');
    }

    switch (type) {
      case 'CONDITION': {
        const condition: { type: string; [field: string]: any } = {
          field: text(own(description, 'field'), `a condition's field`),
          operator: QueryBuilder.word(own(description, 'operator'), OPERATORS, `a condition's operator`),
          value: values(own(description, 'value')),
          caseSensitive: own(description, 'caseSensitive') === true,
          type: 'CONDITION',
        };
        if (own(description, 'empty') === true) {
          condition.empty = true;
        }
        return condition;
      }
      case 'LOGICAL':
        return {
          type: 'LOGICAL',
          operator: QueryBuilder.word(own(description, 'operator'), LOGICAL_OPERATORS, 'a logical operator'),
        };
      case 'SELECT': {
        const fields = own(description, 'fields');
        return fields === undefined
          ? { type: 'SELECT' }
          : { type: 'SELECT', fields: texts(fields, `a select's fields`) };
      }
      case 'AGGREGATE': {
        const aggregate: { type: string; [field: string]: any } = {
          function: QueryBuilder.word(own(description, 'function'), AGGREGATE_FUNCTIONS, 'an aggregate function'),
          field: text(own(description, 'field'), `an aggregate's field`),
          type: 'AGGREGATE',
        };
        const resultProp = own(description, 'resultProp');
        if (resultProp !== undefined && resultProp !== '') {
          aggregate.resultProp = QueryBuilder.resultName(resultProp, `an aggregate's result name`);
        }
        return aggregate;
      }
      case 'GROUP_BY':
        return { type: 'GROUP_BY', fields: texts(own(description, 'fields'), `a group-by's fields`) };
      case 'TIME_BUCKET':
        return {
          field: text(own(description, 'field'), `a time bucket's field`),
          unit: QueryBuilder.word(own(description, 'unit'), TIME_BUCKET_UNITS, `a time bucket's unit`),
          resultProp: QueryBuilder.resultName(own(description, 'resultProp'), `a time bucket's result name`),
          type: 'TIME_BUCKET',
        };
      case 'PAGINATION':
        return {
          type: 'PAGINATION',
          ...QueryBuilder.page({ start: own(description, 'start'), end: own(description, 'end') }),
        };
      case 'SORT': {
        const sort = own(description, 'criteria');
        const criteria: { [field: string]: any } = { field: text(own(sort, 'field'), `a sort's field`) };
        const desc = own(sort, 'desc');
        if (desc !== undefined) {
          criteria.desc = !!desc;
        }
        const byValues = own(sort, 'byValues');
        if (byValues !== undefined) {
          criteria.byValues = QueryBuilder.listOfADescription(byValues, `a sort's values`).map(value);
        }
        return { type: 'SORT', criteria };
      }
      default:
        throw QueryBuilder.notAQuery('a part of it is of no kind a query has');
    }
  }

  /** A list a description holds, as a new list of its own items. */
  private static listOfADescription(value: unknown, kind: string): unknown[] {
    if (!Array.isArray(value)) {
      throw QueryBuilder.notAQuery(`${kind} are not a list`);
    }

    return Array.prototype.slice.call(value);
  }

  /**
   * The copy the code makes of a builder it holds is marked, query for query, as its source is. The copy
   * comes back from a text the code itself wrote a moment ago, so every builder of it arrives marked as
   * read: each takes its source's word instead, and only a builder whose source is the code's own has the
   * mark taken off. The places looked at are the places a statement writes a query from: a condition's
   * value, a list of values, a sort's values.
   */
  private static seatOrigin(source: QueryBuilder<any>, copy: QueryBuilder<any>): void {
    if (QueryBuilder.isTheCodesOwn(source)) {
      delete (copy as any)[READ_FROM_TEXT];
    }

    const each = (value: any): any[] => (Array.isArray(value) ? value : [value]);
    const places = [(node: any) => node?.value, (node: any) => node?.criteria?.byValues];
    const nodeIds: string[] = typeof source.graph?.nodes === 'function' ? source.graph.nodes() : [];
    for (const nodeId of nodeIds) {
      const sourceNode: any = source.graph.node(nodeId);
      const copyNode: any = copy.graph.node(nodeId);
      for (const place of places) {
        const copies = each(place(copyNode));
        each(place(sourceNode)).forEach((inner, index) => {
          if (isInstanceOf(inner, QueryBuilder) && isInstanceOf(copies[index], QueryBuilder)) {
            QueryBuilder.seatOrigin(inner, copies[index]);
          }
        });
      }
    }
  }

  /** A page: two whole numbers, the start not below zero and the end not before the start. */
  private static page(pagination: { start: unknown; end: unknown }): Pagination {
    const { start, end } = pagination;
    const whole = (n: unknown): n is number =>
      typeof n === 'number' && Math.floor(n) === n && Math.abs(n) <= 9007199254740991;
    if (!whole(start) || !whole(end) || start < 0 || end < start) {
      throw new Error(`QueryBuilder: a page is not two whole numbers in their order — no statement was written`);
    }

    return { start, end };
  }
}
