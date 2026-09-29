import type { Configuration } from '@azure/msal-browser';
import { azureClientId, azureTenantId } from './env';
import { allowedEmailDomain } from './organization';

export function getMsalConfig(): Configuration {
  return {
    auth: {
      clientId: azureClientId,
      authority: `https://login.microsoftonline.com/${azureTenantId}`,
      redirectUri:
        typeof window !== 'undefined' ? window.location.origin : '/',
      postLogoutRedirectUri:
        typeof window !== 'undefined' ? window.location.origin : '/',
    },
    cache: {
      cacheLocation: 'sessionStorage',
    },
  };
}

export const loginRequest = {
  // Mail scopes at login so send does not need a second consent popup.
  scopes: ['User.Read', 'Mail.Send', 'Mail.ReadWrite'],
  extraQueryParameters: {
    domain_hint: allowedEmailDomain,
  },
};

/** Same Graph scopes as login; no domain_hint (conflicts with login_hint). */
export const mailRequest = {
  scopes: ['User.Read', 'Mail.Send', 'Mail.ReadWrite'],
};
