/**
 * Google service-account authentication.
 *
 * Signs a JWT with `node:crypto` and exchanges it for an access token, so the
 * project needs no Google client library. Tokens are cached until shortly
 * before expiry and refreshed through a single shared promise.
 */

import { createSign } from "node:crypto";

import type { SheetsConfig } from "../config";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/** Refresh this long before the token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signedAssertion(config: SheetsConfig): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      exp: issuedAt + 3600,
      iat: issuedAt,
    }),
  );
  const body = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(body);
  signer.end();
  return `${body}.${base64url(signer.sign(config.privateKey))}`;
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

export function createTokenProvider(config: SheetsConfig): TokenProvider {
  let token: string | null = null;
  let expiresAt = 0;
  let inFlight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    let assertion: string;
    try {
      assertion = signedAssertion(config);
    } catch (error) {
      throw new GoogleAuthError(
        `Could not sign the service-account JWT. Check GOOGLE_PRIVATE_KEY is the full PEM block: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    const body = (await response.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; error_description?: string; error?: string }
      | null;

    if (!response.ok || !body?.access_token) {
      const detail = body?.error_description ?? body?.error ?? `HTTP ${response.status}`;
      throw new GoogleAuthError(`Google token exchange failed: ${detail}`);
    }

    token = body.access_token;
    expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS;
    return token;
  }

  return {
    async getAccessToken() {
      if (token && Date.now() < expiresAt) return token;
      // Collapse concurrent refreshes onto one request.
      inFlight ??= fetchToken().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
