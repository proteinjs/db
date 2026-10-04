import { SourceRepository } from '@proteinjs/reflection';
import { Session, SessionData, SessionDataStorage } from '@proteinjs/server-api';
import { UserRepo } from '@proteinjs/user';

/**
 * The one session a suite's calls run in: a process-wide session store (the async-context store a
 * server uses does not survive jest's hook and test boundaries), registered where `Session` looks
 * for one, carrying the user the scoped db reads its scope from. `as(user)` re-seats the session
 * on another user, so a suite can act as two people.
 */
export class TestSession implements SessionDataStorage {
  environment = 'node' as const;
  priority = 1;
  private static data: SessionData = { sessionId: 'settings-test', user: undefined, data: {} };

  /** Act as `user` from here on: the session's user, and the scope every scoped write and query carries. */
  static as(user: { id: string; email: string; name: string }): void {
    TestSession.register();
    Session.setData({ sessionId: 'settings-test', user: user.email, data: {} });
    new UserRepo().setUser({ ...user, roles: [] } as unknown as Parameters<UserRepo['setUser']>[0]);
  }

  setData(data: SessionData): void {
    TestSession.data = data;
  }

  getData(): SessionData {
    return TestSession.data;
  }

  private static register(): void {
    const repository = SourceRepository.get() as unknown as { objectCache: { [type: string]: unknown[] } };
    repository.objectCache['@proteinjs/server-api/SessionDataStorage'] = [new TestSession()];
  }
}
