import { StatementFactory } from '../src/StatementFactory';

describe('StatementFactory.createIndex', () => {
  const factory = new StatementFactory();

  test('an index with no declared direction is created all-ascending, exactly as before', () => {
    expect(factory.createIndex({ name: 'feed_owner_posted', columns: ['owner', 'posted_on'] }, 'feed').sql).toBe(
      'CREATE INDEX feed_owner_posted ON `feed`(`owner`, `posted_on`)'
    );
    expect(factory.createIndex({ columns: 'email', unique: true }, 'user').sql).toBe(
      'CREATE UNIQUE INDEX user_email_unique ON `user`(`email`)'
    );
  });

  test('a descending key column carries DESC in its place; the others ascend', () => {
    expect(
      factory.createIndex(
        { name: 'feed_owner_posted', columns: ['owner', 'posted_on', 'id'], descending: ['posted_on'] },
        'feed'
      ).sql
    ).toBe('CREATE INDEX feed_owner_posted ON `feed`(`owner`, `posted_on` DESC, `id`)');
  });
});
