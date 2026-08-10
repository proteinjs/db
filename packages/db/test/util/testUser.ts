import { UserAuth } from '@proteinjs/user-auth';

/**
 * Explicit test identity for suites that exercise non-system `Db` paths.
 *
 * `UserAuth` is FAIL-CLOSED: with no registered `AuthenticatedUserRepo` every table gate denies.
 * Test harnesses that run `Db` outside a server (driver suites, the reusable CRUD suites) must
 * therefore say who they are instead of leaning on an open gate. Register in `beforeAll`, clear
 * in `afterAll`; `DbTestEnvironment` does both for the reusable suites.
 *
 * The static is reached via a runtime cast per the test-harness convention — widening `UserAuth`
 * with a setter only tests need would be the wrong trade.
 *
 * @internal This module is intended to be used only in tests. Do not use it in production code.
 */

type UserAuthInternals = { userRepo?: { getUser: () => { email: string; roles: string[] } } };

/** Register an explicit identity on `UserAuth` (admin by default — the reusable suites test CRUD, not table doors). */
export const registerTestUser = (roles: string[] = ['admin'], email = 'db-test-user@test.local') => {
  (UserAuth as unknown as UserAuthInternals).userRepo = { getUser: () => ({ email, roles }) };
};

/** Remove the registered test identity, restoring the deny-everything unregistered state. */
export const clearTestUser = () => {
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
};
