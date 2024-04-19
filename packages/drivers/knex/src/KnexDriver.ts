import knex from 'knex';
import { DbDriver, DbDriverStatementConfig, SerializedRecord, TableManager } from '@proteinjs/db';
import { KnexConfig, getKnexConfig } from './KnexConfig';
import { Logger } from '@proteinjs/util';
import { Statement } from '@proteinjs/db-query';
import { KnexSchemaOperations } from './KnexSchemaOperations';
import { KnexColumnTypeFactory } from './KnexColumnTypeFactory';

export class KnexDriver implements DbDriver {
	private static KNEX: knex;
	private logger = new Logger(this.constructor.name);
	private config: KnexConfig;
	private knexConfig: any;

	constructor(config?: KnexConfig) {
		this.config = config ? config : getKnexConfig();
		this.knexConfig = {
			client: 'mysql',
			connection: {
				host: this.config.host,
				user: this.config.user,
				password: this.config.password,
			}
		};
	}

	getKnex(): knex {
		if (!KnexDriver.KNEX)
			KnexDriver.KNEX = knex(this.knexConfig);

		return KnexDriver.KNEX;
	}

	getDbName() {
		return this.config.dbName as string;
	}

	async createDbIfNotExists(): Promise<void> {
		if (await this.dbExists(this.getDbName()))
			return;

		await this.getKnex().raw(`CREATE DATABASE ${this.getDbName()};`);
	}

	private async dbExists(databaseName: string): Promise<boolean> {
		const result: any = await this.getKnex().raw('SHOW DATABASES;');
		for (const existingDatabase of result[0]) {
			if (existingDatabase['Database'] == databaseName)
        return true;
		}

		return false;
	}

	async start() {
		await this.setMaxAllowedPacketSize();
	}

	async stop() {
		await this.getKnex().destroy();
	}

	private async setMaxAllowedPacketSize(): Promise<void> {
		await this.getKnex().raw('SET GLOBAL max_allowed_packet=1073741824;');
		await this.getKnex().destroy();
		KnexDriver.KNEX = knex(this.knexConfig);
		this.logger.info('Set global max_allowed_packet size to 1gb');
	}

	getTableManager(): TableManager {
		const columnTypeFactory = new KnexColumnTypeFactory();
		const schemaOperations = new KnexSchemaOperations(this);
		return new TableManager(this, columnTypeFactory, schemaOperations);
	}

	async runQuery(generateStatement: (config: DbDriverStatementConfig) => Statement): Promise<SerializedRecord[]> {
		const { sql, params } = generateStatement({ useParams: true, prefixTablesWithDb: true });
		try {
			return (await this.getKnex().raw(sql, params as any))[0]; // returns 2 arrays, first is records, second is metadata per record
		} catch(error: any) {
			this.logger.error(`Failed when executing query: ${sql}`);
			throw error;
		}
	}

	async runDml(generateStatement: (config: DbDriverStatementConfig) => Statement): Promise<number> {
		const { affectedRows } = (await this.runQuery(generateStatement) as any);
		return affectedRows;
	}
}