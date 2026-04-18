import * as oracledb from "oracledb";

import { ConnectionProfile, PoolSettings } from "../config/settings";
import { Logger } from "../logging/logger";
import { getOracleDb } from "./oracleClient";

export class OraclePoolManager {
  private readonly pools = new Map<string, Promise<oracledb.Pool>>();

  public constructor(private readonly logger: Logger) {}

  public async getPool(
    profile: ConnectionProfile,
    password: string,
    poolSettings: PoolSettings
  ): Promise<oracledb.Pool> {
    const key = profile.alias.toLowerCase();
    const existing = this.pools.get(key);

    if (existing) {
      return existing;
    }

    const created = this.createPool(profile, password, poolSettings);
    this.pools.set(key, created);

    try {
      return await created;
    } catch (error) {
      this.pools.delete(key);
      throw error;
    }
  }

  public async closeAllPools(): Promise<void> {
    const entries = Array.from(this.pools.entries());
    this.pools.clear();

    await Promise.allSettled(
      entries.map(async ([alias, poolPromise]) => {
        try {
          const pool = await poolPromise;
          await pool.close(10);
          this.logger.info(`Closed Oracle pool for alias '${alias}'.`);
        } catch (error) {
          this.logger.warn(`Failed to close Oracle pool for alias '${alias}'.`, {
            error: String(error)
          });
        }
      })
    );
  }

  public dispose(): void {
    void this.closeAllPools();
  }

  private async createPool(
    profile: ConnectionProfile,
    password: string,
    poolSettings: PoolSettings
  ): Promise<oracledb.Pool> {
    const oracleDb = getOracleDb(this.logger);

    const pool = await oracleDb.createPool({
      user: profile.user,
      password,
      connectString: profile.connectString,
      poolMin: profile.poolMin ?? 0,
      poolMax: profile.poolMax ?? 4,
      poolIncrement: profile.poolIncrement ?? 1,
      queueTimeout: poolSettings.queueTimeoutMs,
      poolTimeout: poolSettings.poolTimeoutSeconds,
      stmtCacheSize: poolSettings.stmtCacheSize,
      poolAlias: `oracleSqlNotebook:${profile.alias.toLowerCase()}`
    });

    this.logger.info(`Created Oracle pool for alias '${profile.alias}'.`);

    return pool;
  }
}
