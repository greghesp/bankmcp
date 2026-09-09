// First-run setup: takes either the Enable Banking application id and key
// file, or Plaid credentials, plus a password, validates them and stores
// them in the data directory. Only reachable while the server has no
// working configuration.
import { createPrivateKey } from "node:crypto";
import { config, looksLikeUuid, saveKeyFile, saveSettings } from "./config.ts";
import { hashPassword } from "./auth.ts";
import { resetKeyCache } from "./enablebanking.ts";

export interface SetupInput {
  provider?: string;
  app_id?: string;
  pem?: string;
  password?: string;
  password2?: string;
  country?: string;
  plaid_client_id?: string;
  plaid_secret?: string;
  plaid_env?: string;
}

export function setupAvailable(): boolean {
  const hasPassword = config.localMode || Boolean(config.adminPasswordHash || config.adminPassword);
  const providerReady = config.provider === "plaid" ? Boolean(config.plaidClientId && config.plaidSecret) : Boolean(config.appId && (config.privateKey || config.privateKeyPath));
  return !config.lockedByEnv && !(providerReady && hasPassword);
}

/** Returns null on success, otherwise a message for the form. */
export function applySetup(input: SetupInput): string | null {
  const provider = input.provider === "plaid" ? "plaid" : "enablebanking";
  const password = input.password ?? "";
  const country = (input.country ?? "").trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) return "Country should be a two-letter code such as DK.";
  if (!config.localMode) {
    if (password.length < 12) return "Use a password of at least 12 characters. It is the only thing between the internet and your accounts.";
    if (password !== input.password2) return "The two passwords do not match.";
  }

  if (provider === "plaid") {
    const clientId = (input.plaid_client_id ?? "").trim();
    const secret = (input.plaid_secret ?? "").trim();
    const plaidEnv = input.plaid_env === "production" ? "production" : "sandbox";
    if (!clientId) return "Enter the Plaid client id from your Plaid dashboard.";
    if (!secret) return "Enter the Plaid secret for the chosen environment.";

    saveSettings({
      provider: "plaid",
      plaid_client_id: clientId,
      plaid_secret: secret,
      plaid_env: plaidEnv,
      admin_password_hash: config.localMode ? undefined : hashPassword(password),
      country: country || undefined,
      setup_completed: new Date().toISOString(),
    });
    return null;
  }

  const appId = (input.app_id ?? "").trim();
  const pem = (input.pem ?? "").trim();
  if (!looksLikeUuid.test(appId)) return "The application id should be a UUID like 8d3f6c2a-1b4e-4f7a-9c2d-5e6f7a8b9c0d. It is shown on the application in the Enable Banking Control Panel.";
  if (!pem.includes("PRIVATE KEY")) return "That does not look like the key file. Choose the .pem file that downloaded when you registered the application.";
  try {
    createPrivateKey(pem);
  } catch {
    return "The key file could not be read as a private key.";
  }

  saveKeyFile(pem);
  saveSettings({
    provider: "enablebanking",
    app_id: appId,
    admin_password_hash: config.localMode ? undefined : hashPassword(password),
    country: country || undefined,
    setup_completed: new Date().toISOString(),
  });
  resetKeyCache();
  return null;
}
