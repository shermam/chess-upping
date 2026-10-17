import { Injectable } from '@angular/core';

/**
 * Lichess OAuth 2 with PKCE. Lichess needs no app registration: the client id
 * is a free-form string and the redirect URI is whatever origin the app runs
 * on, which is why this works unchanged on localhost, preview channels and
 * the live site. No scopes are requested: an authenticated request is all
 * that is needed to export the user's own games at the full rate.
 */
const CLIENT_ID = 'chess-upping';
const AUTHORIZE_URL = 'https://lichess.org/oauth';
const TOKEN_URL = 'https://lichess.org/api/token';
const STORAGE_KEY = 'lichess-oauth-pending';

interface PendingLogin {
  verifier: string;
  state: string;
  next: string;
}

export interface LichessTokenResult {
  token: string;
  next: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

@Injectable({ providedIn: 'root' })
export class LichessAuthService {
  static readonly callbackPath = '/lichess/callback';

  private redirectUri(): string {
    return `${location.origin}${LichessAuthService.callbackPath}`;
  }

  /** Sends the browser to Lichess. `next` is the in-app URL to return to. */
  async startLogin(next = '/'): Promise<void> {
    const pending: PendingLogin = { verifier: randomString(), state: randomString(), next };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: this.redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(pending.verifier),
      state: pending.state,
    });
    location.assign(`${AUTHORIZE_URL}?${params}`);
  }

  /** Exchanges the `code` from the callback URL for an access token. */
  async completeLogin(query: URLSearchParams): Promise<LichessTokenResult> {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    const error = query.get('error');
    if (error)
      throw new Error(`Lichess refused the login: ${query.get('error_description') ?? error}`);
    if (!raw) throw new Error('No Lichess login in progress. Please try again.');
    const pending = JSON.parse(raw) as PendingLogin;
    if (query.get('state') !== pending.state)
      throw new Error('Login state mismatch. Please try again.');
    const code = query.get('code');
    if (!code) throw new Error('Lichess did not return an authorization code.');

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.verifier,
        redirect_uri: this.redirectUri(),
        client_id: CLIENT_ID,
      }),
    });
    if (!response.ok) {
      throw new Error(`Lichess token exchange failed (HTTP ${response.status}).`);
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) throw new Error('Lichess token response had no access token.');
    return { token: body.access_token, next: pending.next || '/' };
  }
}
