// The provider switch: which bank-data provider (Enable Banking or Plaid)
// backs the rest of the app. tools.ts, watcher.ts and cli.ts import `bank`
// (renamed to `eb` at the import site) instead of enablebanking.ts directly,
// so they work unchanged against whichever provider is configured.
import { eb, EnableBankingError } from "./enablebanking.ts";
import { plaid, PlaidError } from "./plaid.ts";
import { config } from "./config.ts";

export const bank = config.provider === "plaid" ? plaid : eb;
export const BankError = config.provider === "plaid" ? PlaidError : EnableBankingError;
