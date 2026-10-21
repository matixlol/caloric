const isLikelyHostname = (value: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value);

const normalizeAuthorizationToken = (value: string, allowOpaqueToken: boolean): string | null => {
  const normalized = value.trim();
  if (!normalized || isLikelyHostname(normalized)) {
    return null;
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalized)) {
    return normalized;
  }
  if (allowOpaqueToken && /^[A-Za-z0-9._~-]{24,}$/.test(normalized)) {
    return normalized;
  }
  return null;
};

// Accepts a JWT (or, when allowed, a long opaque token) with or without the
// `Bearer` prefix and returns a `Bearer <token>` header value. Captured
// sessionStorage values can be hostnames or other junk, which yield null.
export const normalizeAuthorization = (
  value: string | null | undefined,
  allowOpaqueToken = false,
): string | null => {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  const token = normalizeAuthorizationToken(normalized.replace(/^Bearer\s+/i, ""), allowOpaqueToken);
  return token ? `Bearer ${token}` : null;
};
