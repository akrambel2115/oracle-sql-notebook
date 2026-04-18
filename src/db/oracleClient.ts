import * as oracledb from "oracledb";

import type { Logger } from "../logging/logger";

let initialized = false;

export function getOracleDb(logger?: Logger): typeof oracledb {
  if (!initialized) {
    initialized = true;
    logger?.debug("Loaded node-oracledb module.");
  }

  return oracledb;
}
