// Shared structured logger. pino writes newline-delimited JSON to stdout;
// level is configurable via LOG_LEVEL (default "info") so operators can turn
// on "debug" without a code change.

import pino from "pino";

export const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
