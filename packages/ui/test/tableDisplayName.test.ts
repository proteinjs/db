import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { tableDisplayName } from '../src/tableDisplayName';

/**
 * Admin table titles (task #53 part 2, item 6): 'user' titles as 'Users', not 'User Table'.
 * Table carries no display metadata, so the title derives from the table name: humanize, then
 * pluralize the last word with boring s/es/ies rules.
 */

interface Doc extends Record {
  title: string;
}

function stubTable(name: string): Table<Doc> {
  return new (class extends Table<Doc> {
    public name = name;
    public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
  })();
}

describe('tableDisplayName', () => {
  it('pluralizes single-word table names', () => {
    expect(tableDisplayName(stubTable('user'))).toBe('Users');
    expect(tableDisplayName(stubTable('session'))).toBe('Sessions');
    expect(tableDisplayName(stubTable('migration'))).toBe('Migrations');
  });

  it('humanizes snake_case and pluralizes only the last word', () => {
    expect(tableDisplayName(stubTable('access_grant'))).toBe('Access grants');
    expect(tableDisplayName(stubTable('cached_thought'))).toBe('Cached thoughts');
    expect(tableDisplayName(stubTable('usage_event'))).toBe('Usage events');
  });

  it('applies es/ies rules', () => {
    expect(tableDisplayName(stubTable('mailbox'))).toBe('Mailboxes');
    expect(tableDisplayName(stubTable('address'))).toBe('Addresses');
    expect(tableDisplayName(stubTable('category'))).toBe('Categories');
    expect(tableDisplayName(stubTable('day'))).toBe('Days');
  });
});
