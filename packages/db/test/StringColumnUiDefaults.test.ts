/**
 * StringColumn's ui defaults (founder ruling, admin round 3): an unbounded ('MAX') plain-text
 * column is NOT default-hidden anymore — the record form renders any length safely (bounded
 * preview + expand past the inline bound), so the old there-is-no-safe-rendering hide is
 * obsolete. The record TABLE's default pick excludes unbounded text at the pick itself
 * (db-ui), not via this layer. `ui.hidden` remains the author's explicit hide-everywhere,
 * and the columns whose MAX storage isn't prose keep their own explicit ui defaults.
 */
// Table first: it anchors the src module cycle (Table → Record → Columns) the way every
// sibling suite does — importing Columns first evaluates Record before UuidColumn exists.
import '../src/Table';
import { ArrayColumn, ObjectColumn, PasswordColumn, StringColumn, UuidColumn } from '../src/Columns';

describe('StringColumn ui defaults', () => {
  it('an unbounded column is not default-hidden', () => {
    const column = new StringColumn('report', undefined, 'MAX');
    expect(column.options?.ui?.hidden).toBeFalsy();
  });

  it('a bounded column stays not hidden', () => {
    expect(new StringColumn('title').options?.ui?.hidden).toBeFalsy();
    expect(new StringColumn('description', {}, 4000).options?.ui?.hidden).toBeFalsy();
  });

  it("an author's explicit ui.hidden survives on an unbounded column", () => {
    const column = new StringColumn('transcript', { ui: { hidden: true } }, 'MAX');
    expect(column.options?.ui?.hidden).toBe(true);
  });

  it('author options without ui still leave the column visible', () => {
    const column = new StringColumn('notes', { defaultValue: async () => 'x' }, 'MAX');
    expect(column.options?.ui?.hidden).toBeFalsy();
    expect(column.options?.defaultValue).toBeDefined();
  });

  it('non-prose MAX-storage columns keep their own hidden defaults', () => {
    expect(new ObjectColumn('payload').options?.ui?.hidden).toBe(true);
    expect(new ArrayColumn('items').options?.ui?.hidden).toBe(true);
    expect(new PasswordColumn('password').options?.ui?.hidden).toBe(true);
    expect(new UuidColumn('token').options?.ui?.hidden).toBe(true);
  });
});
