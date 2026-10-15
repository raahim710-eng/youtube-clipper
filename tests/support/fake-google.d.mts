// Types for the test-only Google stand-in (fake-google.mjs).
export const CLIENT_ID: string;
export const CLIENT_SECRET: string;

export type FakeVideo = {
  id: string;
  snippet: { title: string; description: string; tags: string[]; categoryId: string };
  status: Record<string, unknown> & { privacyStatus: string; publishAt?: string };
};

export type FakeGoogleState = {
  base: string;
  codes: Map<string, { challenge: string; redirectUri: string; scope: string }>;
  accessTokens: Map<string, { refreshToken: string; expires: number }>;
  refreshTokens: Set<string>;
  revoked: Set<string>;
  sessions: Map<string, { metadata: unknown; total: number; received: number; done: boolean }>;
  videos: FakeVideo[];
  thumbnails: { videoId: string; bytes: number }[];
  requests: {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    bodyLength: number;
  }[];
  grantScopes: string;
  channels: unknown[];
  failRefreshWithInvalidGrant: boolean;
  dropAfterChunks: number;
  chunksSeen: number;
  forcePrivate: boolean;
  thumbnailError: number | null;
  uploadError: { status: number; reason: string } | null;
  accessTokenLifetime: number;
};

export type FakeResult = { status: number; headers: Record<string, string>; body: string; drop?: boolean };

export function createFakeGoogle(base: string): {
  state: FakeGoogleState;
  handle(request: { method: string; url: string; headers: Record<string, string>; body?: Buffer }): FakeResult;
  fetch: typeof fetch;
};

export function startFakeGoogleServer(port: number): unknown;
