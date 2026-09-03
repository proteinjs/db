export * from './src/Db';
export * from './src/DetachedDbOps';
export * from './src/Table';
export * from './src/RecordAccessError';
export * from './src/auth/TableAuth';
export * from './src/auth/TableServiceAuth';
export * from './src/Columns';
export * from './src/Record';
export * from './src/reference/ReferenceArray';
export * from './src/reference/ArrayMembershipOps';
export * from './src/reference/Reference';
export * from './src/UpdatePreserving';
export * from './src/ContentPreservingRewrite';
export * from './src/reference/ReferenceCache';
export * from './src/RecordIterator';
export * from './src/CursorWindowPager';
export * from './src/source/SourceRecord';
export * from './src/source/SourceRecordRepo';
// The sync runner behind Db.init's source-record leg, aliased: its class name is taken in this
// index by the SourceRecordLoader declaration interface. Public so consumer test harnesses can
// run one boot of the sync directly (the exports map blocks deep dist imports).
export { SourceRecordLoader as SourceRecordSyncRunner } from './src/source/SourceRecordLoader';
export * from './src/MigrationRunner';
export * from './src/QueryBuilderFactory';
export * from './src/TableWatcher';
export * from './src/transaction/Transaction';
export * from './src/transaction/TransactionRunner';
export * from './src/transaction/TransactionContextFactory';

export * from './src/schema/SchemaOperations';
export * from './src/schema/SchemaMetadata';
export * from './src/schema/TableManager';

export * from './src/encryption/MasterKeyProvider';
export * from './src/encryption/InMemoryMasterKeyProvider';
export * from './src/encryption/DbEncryptionConfig';
export * from './src/encryption/DataEncryptionKeyTable';
export * from './src/encryption/DataKeyStore';
export * from './src/encryption/EncryptionEnvelope';
export * from './src/StatementConfigFactory';
export * from './src/encryption/SearchTokenizer';
export * from './src/encryption/EncryptedColumns';
export * from './src/encryption/EncryptedColumnQueryError';
export * from './src/encryption/EncryptedColumnQueryTransform';
export * from './src/TableQueryTransformProvider';
export * from './src/encryption/EncryptionRecordHooks';
export * from './src/encryption/EncryptionTokenMaintenance';
export * from './src/encryption/EncryptionLifecycleWalker';
export * from './src/encryption/EncryptionDerivedTableRegistry';
export * from './src/encryption/LeafPolicy';
export * from './src/encryption/LeafEnvelopeCodec';
export * from './src/encryption/LeafPaths';

export * from './src/tables/tables';
export * from './src/tables/MigrationTable';

export * from './src/services/DbService';
export * from './src/services/MigrationRunnerService';
export * from './src/services/TransactionRunnerService';

export * from '@proteinjs/db-query';
