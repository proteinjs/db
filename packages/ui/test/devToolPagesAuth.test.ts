import { tablesPage } from '../src/pages/TablesPage';
import { hashGeneratorPage } from '../src/pages/HashGeneratorPage';
import { uuidGeneratorPage } from '../src/pages/UuidGeneratorPage';

/**
 * The dev-tool pages (tables browser, hash/uuid generators) declare the abstract 'dev'
 * permission EXPLICITLY instead of leaning on the default-admin fallback. The consumer app maps
 * 'dev' to its roles (admin passes as break-glass), so holders of the consumer's dev roles can
 * reach these tools without holding admin. A page that loses its auth block silently regresses
 * to admin-only — this pins the gate.
 */
describe('dev-tool pages declare the dev permission', () => {
  it('tables browser requires the dev permission', () => {
    expect(tablesPage.auth).toEqual({ permission: 'dev' });
  });

  it('hash generator requires the dev permission', () => {
    expect(hashGeneratorPage.auth).toEqual({ permission: 'dev' });
  });

  it('uuid generator requires the dev permission', () => {
    expect(uuidGeneratorPage.auth).toEqual({ permission: 'dev' });
  });
});
