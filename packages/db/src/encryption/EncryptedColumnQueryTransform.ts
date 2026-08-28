import { isInstanceOf } from '@proteinjs/util';
import {
  Aggregate,
  ColumnQueryTransform,
  ColumnQueryTransformContext,
  Condition,
  QueryBuilder,
  SortCriteria,
} from '@proteinjs/db-query';
import type { Column, ColumnQueryRuntime, EncryptedColumnConfig, Table } from '../Table';
import { EncryptedColumns, EncryptionSearchToken } from './EncryptedColumns';
import { EncryptedColumnQueryError } from './EncryptedColumnQueryError';
import { getDbEncryptionConfig } from './DbEncryptionConfig';
import { DataKeyMaterial, DataKeyStore } from './DataKeyStore';
import { SearchTokenizer } from './SearchTokenizer';

interface LikeShape {
  kind: 'contains' | 'prefix' | 'suffix' | 'exact' | 'match-any';
  needle: string;
}

/**
 * An encrypted column's `ColumnQueryTransform` — the query-side half of the column's
 * encryption contract (`EncryptionRecordHooks` is the storage-side half). Attached to the
 * column by `EncryptedColumns.ensureSchema` (derived from `ColumnOptions.encrypted`, never
 * caller-declared) and applied by `QueryBuilder.applyColumnTransforms` on every query, so
 * callers keep writing exactly what they write today:
 *
 * - **Equality** (`=`, `IN`) on a column declared `searchable: 'equality'` rewrites onto the
 *   whole-value fingerprint companion — one indexed lookup, exact (fingerprints cover the
 *   exact value), fingerprinted once per accessible key owner (shared-scope reads OR the
 *   owners' fingerprints).
 * - **Contains / prefix LIKE** on a column declared `searchable: 'contains'` resolves in two
 *   index-bounded steps: (1) the token table answers a candidate id set — rows holding ALL
 *   of the query's fragment fingerprints under some accessible owner key; (2) candidates
 *   are verified against the decrypted value (the pg_trgm recheck semantics — no false
 *   positive survives, no true match ≥3-chars-per-word is missed). The condition then
 *   rewrites to the VERIFIED id set, so it composes exactly under any boolean structure,
 *   ORDER BY, pagination, and COUNT.
 * - **Out-of-contract shapes are REJECTED loudly at query-build time** — undeclared ORDER BY,
 *   ranges, arbitrary LIKE patterns, aggregation over the value — each error naming the
 *   sanctioned paths. A limitation a developer cannot hit silently is a contract; one they
 *   discover in production is a bug.
 */
export class EncryptedColumnQueryTransform implements ColumnQueryTransform {
  private encryptedColumns = new EncryptedColumns();
  private tokenizer = new SearchTokenizer();

  constructor(
    private table: Table<any>,
    private prop: string,
    private column: Column<any, any>,
    private config: EncryptedColumnConfig,
    private runtime: ColumnQueryRuntime
  ) {}

  async transformCondition(
    condition: Condition<any>,
    context: ColumnQueryTransformContext
  ): Promise<Condition<any> | undefined> {
    const operator = condition.operator as string;
    if (operator === 'IS NULL' || operator === 'IS NOT NULL') {
      return undefined; // encryption preserves null-ness — native
    }
    if (condition.value === null) {
      return undefined; // `= null` renders IS NULL; a normalized empty-IN renders 1=0
    }
    if (isInstanceOf(condition.value, QueryBuilder)) {
      throw new EncryptedColumnQueryError(
        `Cannot compare encrypted column \`${this.table.name}.${this.prop}\` against a subquery. ` +
          `Compare on a metadata column, or resolve the subquery app-side and pass literal values.`
      );
    }

    switch (operator) {
      case '=':
      case 'IN':
        return await this.equalityCondition(condition, context);
      case 'LIKE':
        return await this.likeCondition(condition, context);
      case '<':
      case '>':
      case '<=':
      case '>=':
      case 'BETWEEN':
        throw new EncryptedColumnQueryError(
          `Cannot apply range condition (${operator}) to encrypted column \`${this.table.name}.${this.prop}\`. ` +
            `Ranges over an encrypted value are not supported. Options: filter by a metadata column; ` +
            `filter the fetched, decrypted rows app-side (bounded sets); or use ` +
            `encrypted: { sortKey: { revealPrefix: N } } ordering with app-side refinement.`
        );
      default:
        // <>, !=, NOT IN, NOT, NOT LIKE — negations over lossy/keyed representations cannot
        // be answered exactly DB-side.
        throw new EncryptedColumnQueryError(
          `Cannot apply ${operator} to encrypted column \`${this.table.name}.${this.prop}\`. Options: use ` +
            `equality/contains conditions (searchable declarations) and exclude app-side; or filter ` +
            `by a metadata column.`
        );
    }
  }

  transformSort(criteria: SortCriteria<any>): SortCriteria<any> {
    if (criteria.byValues && criteria.byValues.length > 0) {
      throw new EncryptedColumnQueryError(
        `Cannot ORDER BY specific values of encrypted column \`${this.table.name}.${this.prop}\`: value-CASE ` +
          `ordering compares the stored value. Options: order by a metadata column; or order the ` +
          `fetched rows for display (bounded sets).`
      );
    }

    if (!this.config.sortKey) {
      throw new EncryptedColumnQueryError(
        `Cannot ORDER BY encrypted column \`${this.table.name}.${this.prop}\` (no sortKey declared). Options: ` +
          `sort by a metadata column; sort the fetched rows for display (bounded sets); or declare ` +
          `encrypted: { sortKey: { revealPrefix: N } } — a documented, bounded reveal of the first ` +
          `N characters' order.`
      );
    }

    return { ...criteria, field: this.encryptedColumns.sortCompanionProp(this.table, this.prop) };
  }

  transformAggregate(aggregate: Aggregate<any>): Aggregate<any> | undefined {
    if (aggregate.function === 'COUNT') {
      return undefined; // counting rows never reads the value — native
    }

    throw new EncryptedColumnQueryError(
      `Cannot ${aggregate.function} encrypted column \`${this.table.name}.${this.prop}\`. Aggregation over ` +
        `an encrypted value is not supported. Options: aggregate a metadata column; or fetch the ` +
        `rows and aggregate the decrypted values app-side (bounded sets).`
    );
  }

  transformGroupByField(): string {
    throw new EncryptedColumnQueryError(
      `Cannot GROUP BY encrypted column \`${this.table.name}.${this.prop}\`. Grouping over an encrypted ` +
        `value is not supported. Options: group by a metadata column; or group the fetched, ` +
        `decrypted rows app-side (bounded sets).`
    );
  }

  private async equalityCondition(
    condition: Condition<any>,
    context: ColumnQueryTransformContext
  ): Promise<Condition<any>> {
    if (this.config.searchable !== 'equality') {
      throw new EncryptedColumnQueryError(
        `Cannot compare encrypted column \`${this.table.name}.${this.prop}\` by value (${condition.operator}): ` +
          `the column does not declare encrypted: { searchable: 'equality' }. Options: declare it (plus the ` +
          `lifecycle backfill) for indexed exact lookups; declare searchable: 'contains' and use LIKE; ` +
          `or look the row up by a metadata column.`
      );
    }
    if (!context.caseSensitive) {
      throw new EncryptedColumnQueryError(
        `Cannot case-insensitively compare encrypted column \`${this.table.name}.${this.prop}\`: equality ` +
          `fingerprints cover the exact value. Options: compare the exact value; or declare ` +
          `searchable: 'contains' and use LIKE for token-normalized matching.`
      );
    }

    const values: any[] = Array.isArray(condition.value) ? condition.value : [condition.value];
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new EncryptedColumnQueryError(
          `Encrypted column \`${this.table.name}.${this.prop}\` equality values must be strings; ` +
            `got ${typeof value}.`
        );
      }
    }

    const keys = await this.accessibleIndexKeys();
    const fingerprints: string[] = [];
    for (const key of keys) {
      for (const value of values) {
        fingerprints.push(this.tokenizer.equalityFingerprint(value, key.indexKey));
      }
    }

    const companionProp = this.encryptedColumns.eqCompanionProp(this.table, this.prop);
    if (fingerprints.length === 1) {
      return { field: companionProp, operator: '=', value: fingerprints[0] };
    }

    return { field: companionProp, operator: 'IN', value: fingerprints };
  }

  private async likeCondition(
    condition: Condition<any>,
    context: ColumnQueryTransformContext
  ): Promise<Condition<any>> {
    if (this.config.searchable !== 'contains') {
      throw new EncryptedColumnQueryError(
        `Cannot LIKE-search encrypted column \`${this.table.name}.${this.prop}\`: the column does not declare ` +
          `encrypted: { searchable: 'contains' }. Options: declare it (plus the lifecycle backfill) ` +
          `for indexed contains/prefix search; or search a metadata column.`
      );
    }

    const shape = this.parseLikePattern(condition.value);
    if (shape.kind === 'match-any') {
      // LIKE '%' / '%%' — matches every non-null value.
      return { field: this.prop, operator: 'IS NOT NULL' };
    }

    const verifiedIds = await this.verifiedCandidateIds(shape, context.caseSensitive);
    return { field: 'id', operator: 'IN', value: verifiedIds };
  }

  /**
   * The two index-bounded steps of contains search (class doc): token-cover candidates,
   * then decrypt-and-verify. Returns the ids whose values TRULY match the pattern.
   */
  private async verifiedCandidateIds(shape: LikeShape, caseSensitive: boolean): Promise<string[]> {
    const keys = await this.accessibleIndexKeys();
    if (keys.length === 0) {
      return [];
    }

    const fragments = this.tokenizer.fragmentsForQuery(shape.needle);
    if (fragments.length === 0) {
      // A needle with no indexable words (punctuation-only). Verification alone cannot be
      // index-bounded; reject rather than silently scan.
      throw new EncryptedColumnQueryError(
        `Cannot search encrypted column \`${this.table.name}.${this.prop}\` for a pattern with no letters or ` +
          `digits (${JSON.stringify(shape.needle)}). Search patterns must contain at least one word character.`
      );
    }

    const candidateIds = await this.tokenCoverCandidates(fragments, keys);
    if (candidateIds.length === 0) {
      return [];
    }

    const verifyQb = new QueryBuilder<any>(this.table.name)
      .select({ fields: ['id', this.prop] })
      .condition({ field: 'id', operator: 'IN', value: candidateIds });
    const rows = await this.runtime.query(this.table, verifyQb);
    const verified: string[] = [];
    for (const row of rows) {
      const value = row[this.prop];
      if (typeof value === 'string' && this.matches(value, shape, caseSensitive)) {
        verified.push(row.id);
      }
    }

    return verified;
  }

  /** Candidate ids: rows whose token rows cover ALL query fragments under SOME accessible key. */
  private async tokenCoverCandidates(fragments: string[], keys: DataKeyMaterial[]): Promise<string[]> {
    const tokenTable = this.encryptedColumns.tokenTableFor(this.table);
    if (!tokenTable) {
      return [];
    }

    // fingerprint -> the (key, fragment) pairs that produced it
    const fingerprintSources = new Map<string, { keyIndex: number; fragment: string }[]>();
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      for (const fragment of fragments) {
        const fingerprint = this.tokenizer.fingerprint(fragment, keys[keyIndex].indexKey);
        const sources = fingerprintSources.get(fingerprint) ?? [];
        sources.push({ keyIndex, fragment });
        fingerprintSources.set(fingerprint, sources);
      }
    }

    const tokenQb = new QueryBuilder<EncryptionSearchToken>(tokenTable.name)
      .select({ fields: ['recordId', 'token'] })
      .condition({ field: 'columnName', operator: '=', value: this.column.name })
      .condition({ field: 'token', operator: 'IN', value: Array.from(fingerprintSources.keys()) });
    const tokenRows = (await this.runtime.systemQuery(tokenTable, tokenQb)) as EncryptionSearchToken[];

    // recordId -> keyIndex -> matched fragments
    const coverage = new Map<string, Map<number, Set<string>>>();
    for (const tokenRow of tokenRows) {
      const sources = fingerprintSources.get(tokenRow.token);
      if (!sources) {
        continue;
      }
      let byKey = coverage.get(tokenRow.recordId);
      if (!byKey) {
        byKey = new Map();
        coverage.set(tokenRow.recordId, byKey);
      }
      for (const source of sources) {
        let matched = byKey.get(source.keyIndex);
        if (!matched) {
          matched = new Set();
          byKey.set(source.keyIndex, matched);
        }
        matched.add(source.fragment);
      }
    }

    const candidates: string[] = [];
    for (const [recordId, byKey] of Array.from(coverage.entries())) {
      for (const matched of Array.from(byKey.values())) {
        if (matched.size === fragments.length) {
          candidates.push(recordId);
          break;
        }
      }
    }

    return candidates;
  }

  private matches(value: string, shape: LikeShape, caseSensitive: boolean): boolean {
    const haystack = caseSensitive ? value : value.toLowerCase();
    const needle = caseSensitive ? shape.needle : shape.needle.toLowerCase();
    switch (shape.kind) {
      case 'contains':
        return haystack.includes(needle);
      case 'prefix':
        return haystack.startsWith(needle);
      case 'suffix':
        return haystack.endsWith(needle);
      case 'exact':
        return haystack === needle;
      default:
        return false;
    }
  }

  private parseLikePattern(pattern: unknown): LikeShape {
    if (typeof pattern !== 'string') {
      throw new EncryptedColumnQueryError(
        `Encrypted column \`${this.table.name}.${this.prop}\` LIKE patterns must be strings; ` +
          `got ${typeof pattern}.`
      );
    }

    const rejectPattern = () => {
      throw new EncryptedColumnQueryError(
        `Cannot apply LIKE pattern ${JSON.stringify(pattern)} to encrypted column ` +
          `\`${this.table.name}.${this.prop}\`. Supported: contains ('%q%'), prefix ('q%'), suffix ('%q'), ` +
          `and exact ('q'). Mid-pattern wildcards, '_' wildcards, and escapes are not supported on ` +
          `encrypted columns; search a metadata column for those shapes.`
      );
    };

    const leading = pattern.startsWith('%');
    const trailing = pattern.endsWith('%') && pattern.length > (leading ? 1 : 0);
    const needle = pattern.slice(leading ? 1 : 0, trailing ? -1 : undefined);
    if (needle.length === 0) {
      if (leading || trailing) {
        return { kind: 'match-any', needle: '' };
      }
      return { kind: 'exact', needle: '' };
    }
    if (needle.includes('%') || needle.includes('_') || needle.includes('\\')) {
      rejectPattern();
    }

    if (leading && trailing) {
      return { kind: 'contains', needle };
    }
    if (trailing) {
      return { kind: 'prefix', needle };
    }
    if (leading) {
      return { kind: 'suffix', needle };
    }
    return { kind: 'exact', needle };
  }

  private async accessibleIndexKeys(): Promise<DataKeyMaterial[]> {
    const config = getDbEncryptionConfig();
    if (!config.getAccessibleKeyOwners) {
      throw new EncryptedColumnQueryError(
        `A query searches an encrypted column but DbEncryptionConfig.getAccessibleKeyOwners is not ` +
          `configured. Search fingerprints are keyed per owner; the config must supply the caller's ` +
          `accessible key owners (their own id plus owners sharing with them).`
      );
    }

    const owners = await config.getAccessibleKeyOwners({ runAsSystem: this.runtime.runAsSystem });
    return await new DataKeyStore().getQueryIndexKeys(owners);
  }
}
