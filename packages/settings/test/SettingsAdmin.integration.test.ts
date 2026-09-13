import moment from 'moment';
import { Db, Table, getDbAsSystem } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { SpannerEmulatorProvisioner, getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import { SourceRepository } from '@proteinjs/reflection';
import { Session, SessionData, SessionDataStorage } from '@proteinjs/server-api';
import { UserRepo, tables as userTables } from '@proteinjs/user';
import { Settings } from '../src/Settings';
import { SettingsAdmin } from '../src/SettingsAdmin';
import { tables } from '../src/tables/tables';

/**
 * The settings admin door is the ONE path onto another account's settings: a write lands under the
 * TARGET's scope (so the target's own `Settings.get` reads it — one table, one scope), and its
 * `setting_change_event` row commits with it. Outcomes asserted against a real Spanner emulator:
 * the rows written and read back, never the calls made.
 *
 * The service door (`{ permission: 'users' }`) is resolved by ServiceAuth — covered in
 * @proteinjs/service — so these tests call the implementation directly and pin the metadata.
 */

class TestSessionDataStorage implements SessionDataStorage {
  environment = 'node' as const;
  static SESSION_DATA: { [id: string]: SessionData } = {};

  setData(data: SessionData) {
    TestSessionDataStorage.SESSION_DATA['sessionData'] = data;
  }

  getData(): SessionData {
    return TestSessionDataStorage.SESSION_DATA['sessionData'];
  }
}

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

const dropTable = getDropTestTable(spannerDriver);
const userRepo = new UserRepo();

const person = (id: string, name: string, roles: string[] = []) => ({
  id,
  name,
  email: `${id}@test.local`,
  password: 'test',
  emailVerified: true,
  roles,
  created: moment(),
  updated: moment(),
});
const manager = person('manager-1', 'User manager', ['users']);
const member = person('member-1', 'A member');
const other = person('other-1', 'Someone else');

describe("SettingsAdmin — another account's settings, audited", () => {
  beforeAll(async () => {
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [
      { getDbDriver: () => spannerDriver },
    ];
    (SourceRepository.get() as any).objectCache['@proteinjs/server-api/SessionDataStorage'] = [
      new TestSessionDataStorage(),
    ];
    // Tests import src directly (no generated source graph): the table registry the db resolves
    // names through (`tableByName`) is seeded explicitly.
    (SourceRepository.get() as any).objectCache['@proteinjs/db/Table'] = [
      ...Object.values(tables),
      ...Object.values(userTables),
    ];
    jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => spannerDriver);
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    Session.setData({ sessionId: 'test-session', user: 'guest', data: {} });
    const tableManager = spannerDriver.getTableManager();
    for (const table of [tables.Setting, tables.SettingChangeEvent] as Table<any>[]) {
      await dropTable(table);
      await tableManager.loadTable(table);
    }
    await tableManager.loadTable(userTables.User as Table<any>);
    for (const user of [manager, member, other]) {
      await getDbAsSystem().insert(userTables.User, user as any);
    }
  });

  afterAll(async () => {
    for (const table of [tables.Setting, tables.SettingChangeEvent] as Table<any>[]) {
      await dropTable(table);
    }
    await dropTable(userTables.User as Table<any>);
    SpannerEmulatorProvisioner.release();
  });

  beforeEach(async () => {
    const db = getDbAsSystem();
    for (const row of await db.query(tables.Setting, {})) {
      await db.delete(tables.Setting, { id: row.id });
    }
    for (const row of await db.query(tables.SettingChangeEvent, {})) {
      await db.delete(tables.SettingChangeEvent, { id: row.id });
    }
  });

  test('the door is gated on the user-management permission; the audit table opens no generic write', () => {
    expect(new SettingsAdmin().serviceMetadata).toEqual({ auth: { permission: 'users' } });
    const auth = tables.SettingChangeEvent.auth!;
    expect(auth.db?.query).toEqual({ permission: 'users' });
    expect(auth.db?.insert).toBeUndefined();
    expect(auth.db?.update).toBeUndefined();
    expect(auth.db?.delete).toBeUndefined();
    expect(auth.service?.insert).toBeUndefined();
  });

  test("a write lands under the TARGET's scope: the target's own Settings.get reads it, the actor's does not", async () => {
    userRepo.setUser(manager as any);
    await new SettingsAdmin().writeSetting(member.id, 'profile-settings', { themeMode: 'dark' });

    const rows = await getDbAsSystem().query(tables.Setting, { name: 'profile-settings' });
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe(member.id);
    expect(rows[0].value).toEqual({ themeMode: 'dark' });

    userRepo.setUser(member as any);
    expect(await new Settings().get('profile-settings')).toEqual({ themeMode: 'dark' });
    userRepo.setUser(manager as any);
    expect(await new Settings().get('profile-settings', 'none')).toBe('none');
  });

  test('every write carries its audit row — actor · target · name · before · after — and a second write records the first as before', async () => {
    userRepo.setUser(manager as any);
    const admin = new SettingsAdmin();
    await admin.writeSetting(member.id, 'chat-settings', { model: 'a', webSearch: false });
    await admin.writeSetting(member.id, 'chat-settings', { model: 'a', webSearch: true });

    const settings = await getDbAsSystem().query(tables.Setting, { scope: member.id, name: 'chat-settings' });
    expect(settings).toHaveLength(1); // the second write UPDATED the row — never a second row
    expect(settings[0].value).toEqual({ model: 'a', webSearch: true });

    const events = (await getDbAsSystem().query(tables.SettingChangeEvent, { target: member.id })).sort(
      (a, b) => moment(a.created).valueOf() - moment(b.created).valueOf()
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actor: manager.id,
      target: member.id,
      name: 'chat-settings',
      before: null,
      after: { model: 'a', webSearch: false },
    });
    expect(events[1]).toMatchObject({
      actor: manager.id,
      target: member.id,
      name: 'chat-settings',
      before: { model: 'a', webSearch: false },
      after: { model: 'a', webSearch: true },
    });
  });

  test("readSettings answers the target's named rows only — a missing name is absent, another account's row never rides", async () => {
    userRepo.setUser(other as any);
    await new Settings().set('profile-settings', { themeMode: 'light' });
    userRepo.setUser(member as any);
    await new Settings().set('notifications-settings', { pinned: true });

    userRepo.setUser(manager as any);
    const read = await new SettingsAdmin().readSettings(member.id, [
      'profile-settings',
      'notifications-settings',
      'chat-settings',
    ]);
    expect(read).toEqual({ 'notifications-settings': { pinned: true } });
    expect('profile-settings' in read).toBe(false);
    expect(await new SettingsAdmin().readSettings(member.id, [])).toEqual({});
  });

  test('a blank account id is refused with the reason, never answered empty', async () => {
    userRepo.setUser(manager as any);
    await expect(new SettingsAdmin().readSettings('', ['profile-settings'])).rejects.toThrow(/user id is required/);
    await expect(new SettingsAdmin().writeSetting('  ', 'profile-settings', {})).rejects.toThrow(/user id is required/);
    await expect(new SettingsAdmin().writeSetting(member.id, '', {})).rejects.toThrow(/setting name is required/);
    expect(await getDbAsSystem().query(tables.SettingChangeEvent, {})).toHaveLength(0);
  });
});
