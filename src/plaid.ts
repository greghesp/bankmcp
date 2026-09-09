// Plaid client, deliberately shaped to match enablebanking.ts's `eb` object
// one-for-one (same method names, same return types — Aspsp, Session,
// SessionStatus, Balance, Transaction, TransactionPage) so the rest of the
// app (tools.ts, watcher.ts, app.ts, cli.ts) can import this instead of
// enablebanking.ts with a one-line change, no other edits required.
//
// The one thing that does NOT map cleanly: Enable Banking's flow is
// "open a URL, log in at the bank, get redirected back with ?code=".
// Plaid's flow is "load Plaid Link (their JS SDK) in a browser, run the
// widget, get a public_token back via a callback in the page". There is no
// bank-hosted redirect URL to hand out. So `startAuthorization` here returns
// a URL pointing at THIS SERVER's own /plaid/link page (see app.ts changes
// in INTEGRATION.md) instead of a bank URL — from the MCP tool's point of
// view (start_consent returns "a URL to open") nothing changes.
import { config } from "./config.ts";
import { store } from "./store.ts";
import type { Application, Aspsp, Balance, Session, SessionStatus, Transaction, TransactionPage } from "./enablebanking.ts";

export class PlaidError extends Error {
  status: number;
  body: string;
  errorCode?: string;
  constructor(status: number, body: string) {
    let errorCode: string | undefined;
    try {
      errorCode = JSON.parse(body)?.error_code;
    } catch {
      /* not JSON */
    }
    super(`Plaid API ${status}${errorCode ? ` (${errorCode})` : ""}: ${body}`);
    this.status = status;
    this.body = body;
    this.errorCode = errorCode;
  }
  /** True when the Item needs the user to reconnect (equivalent to EnableBankingError#consentGone). */
  get consentGone(): boolean {
    return this.errorCode === "ITEM_LOGIN_REQUIRED" || this.errorCode === "ITEM_NOT_FOUND" || this.status === 401;
  }
}

// --- HTTP ---
// Plaid ENVIRONMENTS: sandbox (fake banks, free) and production (real banks,
// billed per Item/call once out of the free trial allowance). No separate
// staging tier as of 2026 — see https://plaid.com/docs/api/ for current terms.
const apiBase = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" }[config.plaidEnv];

async function api<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(new URL(path, apiBase), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.plaidClientId, secret: config.plaidSecret, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new PlaidError(res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

// --- Plaid's own wire types (kept minimal — just what we use) ---

interface PlaidInstitution {
  institution_id: string;
  name: string;
  country_codes: string[];
  products: string[];
}

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string;
  mask?: string;
  type: string; // depository, credit, loan, investment...
  subtype?: string;
  balances: { available: number | null; current: number | null; iso_currency_code: string | null };
}

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number; // Plaid convention: POSITIVE = money out, NEGATIVE = money in
  iso_currency_code: string | null;
  date: string;
  pending: boolean;
  merchant_name?: string;
  name: string;
  personal_finance_category?: { primary?: string };
}

// --- Mapping helpers: Plaid's shapes -> Enable Banking's shapes, so
// data.ts's simplifyBalances/simplifyTransaction work completely unchanged. ---

function toBalances(a: PlaidAccount): Balance[] {
  const currency = a.balances.iso_currency_code ?? "GBP";
  const out: Balance[] = [];
  // "current" is the settled/booked figure; map to ITBD so data.ts's
  // booked-balance preference order (CLBD > ITBD > CLAV > ITAV > XPCD) picks it up.
  if (a.balances.current !== null) out.push({ balance_amount: { currency, amount: String(a.balances.current) }, balance_type: "ITBD" });
  // "available" (spendable / available credit) maps to XPCD, data.ts's
  // dedicated "available" slot.
  if (a.balances.available !== null) out.push({ balance_amount: { currency, amount: String(a.balances.available) }, balance_type: "XPCD" });
  return out;
}

function toTransaction(t: PlaidTransaction): Transaction {
  // Plaid: positive amount = debit (money out). Enable Banking: separate
  // signed amount + CRDT/DBIT indicator. Normalise to EB's convention.
  const debit = t.amount > 0;
  const name = t.merchant_name || t.name;
  return {
    transaction_id: t.transaction_id,
    transaction_amount: { currency: t.iso_currency_code ?? "GBP", amount: String(Math.abs(t.amount)) },
    credit_debit_indicator: debit ? "DBIT" : "CRDT",
    status: t.pending ? "PDNG" : "BOOK",
    booking_date: t.date,
    creditor: debit ? { name } : undefined,
    debtor: debit ? undefined : { name },
    remittance_information: [name],
    merchant_category_code: t.personal_finance_category?.primary,
  };
}

// --- Public surface, matching `eb` in enablebanking.ts ---

export const plaid = {
  /** No direct Plaid equivalent to EB's /application; used only for a config sanity check. */
  getApplication: async (): Promise<Application> => {
    // /institutions/get with count:1 is a cheap way to confirm the
    // credentials work, mirroring what cli.ts's `eb.getApplication()` check does.
    await api("/institutions/get", { count: 1, offset: 0, country_codes: [config.country] });
    return { name: "Plaid", kid: config.plaidClientId, environment: config.plaidEnv.toUpperCase() as "SANDBOX" | "PRODUCTION", redirect_urls: [], active: true };
  },

  listAspsps: async (country: string): Promise<Aspsp[]> => {
    const { institutions } = await api<{ institutions: PlaidInstitution[] }>("/institutions/get", {
      count: 500,
      offset: 0,
      country_codes: [country],
      options: { products: ["transactions"] },
    });
    return institutions.map((i) => ({ name: i.name, country, psu_types: ["personal"] }));
  },

  /**
   * Enable Banking returns a bank login URL directly. Plaid instead needs a
   * link_token that a browser-side Plaid Link widget consumes. We return
   * that link_token; app.ts's /plaid/link route turns it into the URL
   * start_consent hands back to the assistant.
   */
  createLinkToken: async (input: { redirectUri: string }): Promise<{ link_token: string }> =>
    api<{ link_token: string }>("/link/token/create", {
      client_name: config.appName,
      language: "en",
      country_codes: [config.country],
      user: { client_user_id: "bankmcp-single-user" }, // single-household server: one fixed user id is fine
      products: ["transactions"],
      redirect_uri: input.redirectUri || undefined,
    }),

  /** Called once the Plaid Link widget succeeds and posts back a public_token. */
  exchangePublicToken: async (publicToken: string): Promise<Session & { secret: string }> => {
    const { access_token, item_id } = await api<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
    const { accounts, item } = await api<{ accounts: PlaidAccount[]; item: { institution_id?: string } }>("/accounts/get", { access_token });
    let institutionName = item.institution_id ?? "Bank";
    if (item.institution_id) {
      try {
        const { institution } = await api<{ institution: PlaidInstitution }>("/institutions/get_by_id", { institution_id: item.institution_id, country_codes: [config.country] });
        institutionName = institution.name;
      } catch {
        /* keep the id as a fallback name */
      }
    }
    // UK Open Banking requires re-consent roughly every 90 days regardless of
    // aggregator; Plaid surfaces this as an ITEM_LOGIN_REQUIRED error when it
    // happens rather than a fixed expiry up front, so this is informational,
    // not enforced — see watcher.ts's consentGone handling for the real signal.
    const softValidUntil = new Date(Date.now() + 90 * 86_400_000).toISOString();
    return {
      session_id: item_id,
      accounts: accounts.map((a) => ({
        uid: `${item_id}:${a.account_id}`,
        account_id: { other: { identification: a.mask, scheme_name: "plaid_mask" } },
        name: a.official_name || a.name,
        product: a.subtype,
        currency: a.balances.iso_currency_code ?? (config.country === "GB" ? "GBP" : "EUR"),
        cash_account_type: a.type,
        identification_hash: a.account_id, // Plaid's account_id is already stable per Item
      })),
      aspsp: { name: institutionName, country: config.country },
      psu_type: "personal",
      access: { valid_until: softValidUntil },
      // Plaid-only: the Item's access_token, carried alongside the Session so
      // store.addSession can stash it on the StoredSession (see store.ts's
      // `secret` field). Enable Banking sessions never set this.
      secret: access_token,
    };
  },

  getSession: async (sessionId: string): Promise<SessionStatus> => {
    const accessToken = accessTokenFor(sessionId);
    try {
      await api("/accounts/get", { access_token: accessToken });
      return { status: "AUTHORIZED", accounts: [], aspsp: { name: "", country: "" }, access: { valid_until: "" }, created: "" };
    } catch (err) {
      if (err instanceof PlaidError && err.consentGone) return { status: "EXPIRED", accounts: [], aspsp: { name: "", country: "" }, access: { valid_until: "" }, created: "" };
      throw err;
    }
  },

  deleteSession: async (sessionId: string): Promise<unknown> => {
    const accessToken = accessTokenFor(sessionId);
    return api("/item/remove", { access_token: accessToken });
  },

  getBalances: async (accountUid: string): Promise<Balance[]> => {
    const [itemId, accountId] = accountUid.split(":");
    const accessToken = accessTokenFor(itemId!);
    const { accounts } = await api<{ accounts: PlaidAccount[] }>("/accounts/balance/get", { access_token: accessToken, options: { account_ids: [accountId] } });
    const account = accounts.find((a) => a.account_id === accountId);
    return account ? toBalances(account) : [];
  },

  getTransactionPage: async (accountUid: string, opts: { dateFrom?: string; dateTo?: string; continuationKey?: string } = {}): Promise<TransactionPage> => {
    const [itemId, accountId] = accountUid.split(":");
    const accessToken = accessTokenFor(itemId!);
    const { added, next_cursor, has_more } = await api<{ added: PlaidTransaction[]; next_cursor: string; has_more: boolean }>("/transactions/sync", {
      access_token: accessToken,
      cursor: opts.continuationKey || undefined,
    });
    const filtered = added
      .filter((t) => t.account_id === accountId)
      .filter((t) => (!opts.dateFrom || t.date >= opts.dateFrom) && (!opts.dateTo || t.date <= opts.dateTo));
    return { transactions: filtered.map(toTransaction), continuation_key: has_more ? next_cursor : undefined };
  },
};

/** The Item's access_token, stored on the StoredSession by store.addSession(). */
function accessTokenFor(itemId: string): string {
  const secret = store().data.sessions[itemId]?.secret;
  if (!secret) throw new PlaidError(401, JSON.stringify({ error_code: "ITEM_NOT_FOUND" }));
  return secret;
}
