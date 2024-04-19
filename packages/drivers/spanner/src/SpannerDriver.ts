import { Database, Instance, Spanner } from '@google-cloud/spanner';
import { DbDriver, DbDriverStatementConfig, TableManager } from '@proteinjs/db';
import { SpannerConfig, getSpannerConfig } from './SpannerConfig';
import { Logger } from '@proteinjs/util';
import { Statement } from '@proteinjs/db-query';
import { SpannerSchemaOperations } from './SpannerSchemaOperations';
import { SpannerColumnTypeFactory } from './SpannerColumnTypeFactory';
import { SpannerSchemaMetadata } from './SpannerSchemaMetadata';

export class SpannerDriver implements DbDriver {
	private static SPANNER: Spanner;
	private static SPANNER_INSTANCE: Instance;
	private static SPANNER_DB: Database;
	private logger = new Logger(this.constructor.name);
	private config: SpannerConfig;

	constructor(config?: SpannerConfig) {
		this.config = config ? config : getSpannerConfig();
	}

	private getSpanner(): Spanner {
		if (!SpannerDriver.SPANNER)
			SpannerDriver.SPANNER = new Spanner({ projectId: this.config.projectId });


		return SpannerDriver.SPANNER;
	}

	private getSpannerInstance(): Instance {
		if (!SpannerDriver.SPANNER_INSTANCE)
			SpannerDriver.SPANNER_INSTANCE = this.getSpanner().instance(this.config.instanceName);

		return SpannerDriver.SPANNER_INSTANCE;
	}

	private getSpannerDb(): Database {
		if (!SpannerDriver.SPANNER_DB)
			SpannerDriver.SPANNER_DB = this.getSpannerInstance().database(this.config.databaseName);

		return SpannerDriver.SPANNER_DB;
	}

	getDbName() {
		return this.config.databaseName;
	}

	getTableManager(): TableManager {
		const columnTypeFactory = new SpannerColumnTypeFactory();
		const schemaOperations = new SpannerSchemaOperations(this);
		const schemaMetadata = new SpannerSchemaMetadata(this, false);
		return new TableManager(this, columnTypeFactory, schemaOperations, schemaMetadata);
	}

	async createDbIfNotExists(): Promise<void> {
		if (await this.dbExists(this.getDbName()))
			return;

		await this.getSpannerInstance().createDatabase(this.getDbName());
	}

	private async dbExists(databaseName: string): Promise<boolean> {
		const [exists] = await this.getSpannerInstance().database(databaseName).exists();
		return exists;
	}

	async runQuery(generateStatement: (config: DbDriverStatementConfig) => Statement): Promise<any[]> {
		const { sql, namedParams } = generateStatement({ useParams: true, useNamedParams: true, prefixTablesWithDb: false });
		try {
			this.logger.debug(`Executing query: ${sql}`);
			const [rows] = await this.getSpannerDb().run({ sql, params: namedParams?.params });
			return rows.map(row => row.toJSON());
			// return JSON.parse(JSON.stringify((await this.getSpannerDb().run({ sql, params: namedParams?.params }))[0]));
		} catch(error: any) {
			this.logger.error(`Failed when executing query: ${sql}\nreason: ${error.details}`);
			throw error;
		}
	}

	/**
	 * Execute a write operation.
	 * 
	 * @returns number of affected rows
	 */
	async runDml(generateStatement: (config: DbDriverStatementConfig) => Statement): Promise<number> {
		const { sql, namedParams } = generateStatement({ useParams: true, useNamedParams: true, prefixTablesWithDb: false });
		try {
			return await this.getSpannerDb().runTransactionAsync(async (transaction) => {
				this.logger.debug(`Executing dml: ${sql}`);
				const [rowCount] = await transaction.runUpdate({
					sql,
					params: namedParams?.params,
				});
				await transaction.commit();
				return rowCount;
			});
		} catch(error: any) {
			this.logger.error(`Failed when executing dml: ${sql}\nreason: ${error.details}`);
			throw error;
		}
	}

	/**
	 * Execute a schema write operation.
	 */
	async runUpdateSchema(sql: string): Promise<void> {
		try {
			this.logger.debug(`Executing schema update: ${sql}`)
			const [operation] = await this.getSpannerDb().updateSchema(sql);
      await operation.promise();
		} catch(error: any) {
			this.logger.error(`Failed when executing schema update: ${sql}\nreason: ${error.details}`);
			throw error;
		}
	}
}