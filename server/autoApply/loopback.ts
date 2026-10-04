// Loopback-only Host-header allowlist for the local desktop-bridge API.
// Defense-in-depth, never the sole auth.

export function isAllowedLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  if (host === '127.0.0.1:3000' || host === 'localhost:3000' || host === '[::1]:3000') return true;
  return false;
}

export function assertLoopbackHost(hostHeader: string | undefined): void {
  if (!isAllowedLoopbackHost(hostHeader)) {
    const err = new Error('Request Host is not a loopback address.');
    (err as Error & { code?: string }).code = 'INVALID_HOST';
    throw err;
  }
}
