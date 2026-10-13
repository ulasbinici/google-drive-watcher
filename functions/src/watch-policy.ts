export const RENEW_LEAD_MS = 36 * 60 * 60 * 1000;

export function needsRenewal(expiresAtMs: number, now = Date.now()): boolean {
  return expiresAtMs <= now + RENEW_LEAD_MS;
}

export function isNewerMessage(previous: string, incoming: string): boolean {
  return BigInt(incoming) > BigInt(previous);
}

export interface ChangePageCursor {
  nextPageToken?: string | null;
  newStartPageToken?: string | null;
}

export function advanceChangeCursor(
  current: string,
  page: ChangePageCursor,
): { pageToken: string; done: boolean } {
  if (page.newStartPageToken) {
    return { pageToken: page.newStartPageToken, done: true };
  }
  if (page.nextPageToken) {
    return { pageToken: page.nextPageToken, done: false };
  }
  return { pageToken: current, done: true };
}
