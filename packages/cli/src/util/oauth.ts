import fetch, { type Response } from 'node-fetch';

// https://vercel.com/.well-known/openid-configuration
export const as: {
  client_id: string;
  device_authorization_endpoint: URL;
  token_endpoint: URL;
  revocation_endpoint: URL;
} = {
  client_id: '', // TODO: Embed client_id
  revocation_endpoint: new URL(
    'https://vercel.com/api/login/oauth/token/revoke'
  ),
  device_authorization_endpoint: new URL(
    'https://vercel.com/api/login/oauth/device-authorization'
  ),
  token_endpoint: new URL('https://vercel.com/api/login/oauth/token'),
};

/**
 * Perform the Device Authorization Request
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628#section-3.1
 */
export async function deviceAuthorizationRequest(options: {
  scope?: string;
}): Promise<Response> {
  return await fetch(as.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: as.client_id, ...options }),
  });
}

/**
 * Process the Device Authorization request Response
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628#section-3.2
 */
export async function processDeviceAuthorizationResponse(
  response: Response
): Promise<
  | [Error]
  | [
      null,
      {
        /** The device verification code. */
        device_code: string;
        /** The end-user verification code. */
        user_code: string;
        /**
         * The minimum amount of time in seconds that the client
         * SHOULD wait between polling requests to the token endpoint.
         * @default 5
         */
        interval: number;
        /** The end-user verification URI on the authorization server. */
        verification_uri: string;
        /**
         * The end-user verification URI on the authorization server,
         * including the `user_code`, without redirection.
         */
        verification_uri_complete: string;
        /**
         * The absolute lifetime of the `device_code` and `user_code`.
         * Calculated from `expires_in`.
         */
        expiresAt: number;
      },
    ]
> {
  const json = await response.json();

  if (!response.ok) {
    return [new OAuthError('Device authorization request failed', json)];
  }

  if (typeof json !== 'object' || json === null)
    return [new TypeError('Expected response to be an object')];
  else if (!('device_code' in json) || typeof json.device_code !== 'string')
    return [new TypeError('Expected `device_code` to be a string')];
  else if (!('user_code' in json) || typeof json.user_code !== 'string')
    return [new TypeError('Expected `user_code` to be a string')];
  else if (
    !('verification_uri' in json) ||
    typeof json.verification_uri !== 'string' ||
    !canParseURL(json.verification_uri)
  ) {
    return [new TypeError('Expected `verification_uri` to be a string')];
  } else if (
    !('verification_uri_complete' in json) ||
    typeof json.verification_uri_complete !== 'string' ||
    !canParseURL(json.verification_uri_complete)
  ) {
    return [
      new TypeError('Expected `verification_uri_complete` to be a string'),
    ];
  } else if (!('expires_in' in json) || typeof json.expires_in !== 'number')
    return [new TypeError('Expected `expires_in` to be a number')];
  else if (!('interval' in json) || typeof json.interval !== 'number')
    return [new TypeError('Expected `interval` to be a number')];

  return [
    null,
    {
      device_code: json.device_code,
      user_code: json.user_code,
      verification_uri: json.verification_uri,
      verification_uri_complete: json.verification_uri_complete,
      expiresAt: Date.now() + json.expires_in * 1000,
      interval: json.interval,
    },
  ];
}

/**
 * Perform the Device Access Token Request
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628#section-3.4
 */
export async function deviceAccessTokenRequest(options: {
  device_code: string;
}): Promise<[Error] | [null, Response]> {
  try {
    return [
      null,
      await fetch(as.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: as.client_id,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          ...options,
        }),
        // TODO: Drop `node-fetch` and just use `signal`
        timeout: 10 * 1000,
        // @ts-expect-error: Signal is part of `fetch` spec, should drop `node-fetch`
        signal: AbortSignal.timeout(10 * 1000),
      }),
    ];
  } catch (error) {
    if (error instanceof Error) return [error];
    return [
      new Error('An unknown error occurred. See the logs for details.', {
        cause: error,
      }),
    ];
  }
}

/**
 * Process the Device Access Token request Response
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628#section-3.5
 */
export async function processDeviceAccessTokenResponse(
  response: Response
): Promise<
  | [OAuthError | TypeError]
  | [
      null,
      {
        /** The access token issued by the authorization server. */
        access_token: string;

        /** The type of the token issued */
        token_type: 'Bearer';
        /** The lifetime in seconds of the access token.The lifetime in seconds of the access token. */
        expires_in: number;
        /** The refresh token, which can be used to obtain new access tokens. */
        refresh_token?: string;
        /** The scope of the access token. */
        scope?: string;
      },
    ]
> {
  const json = await response.json();

  if (!response.ok) {
    return [new OAuthError('Device access token request failed', json)];
  }

  if (typeof json !== 'object' || json === null)
    return [new TypeError('Expected response to be an object')];
  else if (!('access_token' in json) || typeof json.access_token !== 'string')
    return [new TypeError('Expected `access_token` to be a string')];
  else if (!('token_type' in json) || json.token_type !== 'Bearer')
    return [new TypeError('Expected `token_type` to be "Bearer"')];
  else if (!('expires_in' in json) || typeof json.expires_in !== 'number')
    return [new TypeError('Expected `expires_in` to be a number')];
  else if (
    'refresh_token' in json &&
    (typeof json.refresh_token !== 'string' || !json.refresh_token)
  )
    return [new TypeError('Expected `refresh_token` to be a string')];
  else if ('scope' in json && typeof json.scope !== 'string')
    return [new TypeError('Expected `scope` to be a string')];

  return [null, json];
}

/**
 * Perform the Revocation Request.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7009#section-2.1
 */
export async function revocationRequest(options: {
  token: string;
}): Promise<Response> {
  return await fetch(as.revocation_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(options),
  });
}

/**
 * Process Revocation request Response.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7009#section-2.2
 */
export async function processRevocationResponse(
  response: Response
): Promise<[OAuthError | Error] | [null, null]> {
  const json = await response.json();

  if (response.ok) return [null, null];

  return [new OAuthError('Revocation request failed', json)];
}

type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  // Device Athorization Response Errors
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  // Revocation Response Errors
  | 'unsupported_token_type';

interface OAuthErrorResponse {
  error: OAuthErrorCode;
  error_description?: string;
  error_uri?: string;
}

function processOAuthErrorResponse(json: unknown): OAuthErrorResponse {
  if (typeof json !== 'object' || json === null)
    throw new TypeError('Expected response to be an object');
  else if (!('error' in json) || typeof json.error !== 'string')
    throw new TypeError('Expected `error` to be a string');
  else if (
    'error_description' in json &&
    typeof json.error_description !== 'string'
  )
    throw new TypeError('Expected `error_description` to be a string');
  else if ('error_uri' in json && typeof json.error_uri !== 'string')
    throw new TypeError('Expected `error_uri` to be a string');

  return json as OAuthErrorResponse;
}

export class OAuthError extends Error {
  code: OAuthErrorCode;
  cause: Error;
  constructor(message: string, response: unknown) {
    const error = processOAuthErrorResponse(response);
    let cause = error.error;
    if (error.error_description) cause += `: ${error.error_description}`;
    if (error.error_uri) cause += ` (${error.error_uri})`;

    super(message, { cause });
    this.cause = new Error(cause);
    this.code = error.error;
  }
}

export function isOAuthError(error: unknown): error is OAuthError {
  if (typeof error !== 'object' || error === null) return false;
  return error instanceof OAuthError;
}

function canParseURL(url: string) {
  try {
    return !!new URL(url);
  } catch {
    return false;
  }
}