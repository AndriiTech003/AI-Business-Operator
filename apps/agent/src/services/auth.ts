import { and, eq } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import type { MeDto } from '@aio/contracts';
import type { Db } from '../db/client';
import { tenantSettings, userCredentials } from '../db/schema';
import { BopError, type BopClient, type BopMe } from './bop';
import { SecretBox, sha256 } from './crypto';

export interface Identity {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  role: string;
  scopes: string[];
  tenantName: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_PREFIX = 'aio_s.';

function identityFromMe(me: BopMe): Identity {
  return {
    userId: me.user.id,
    tenantId: me.tenant.id,
    name: me.user.name,
    email: me.user.email,
    role: me.role,
    scopes: me.scopes,
    tenantName: me.tenant.name,
  };
}

export function toMeDto(i: Identity): MeDto {
  return {
    userId: i.userId,
    tenantId: i.tenantId,
    name: i.name,
    email: i.email,
    role: i.role,
    scopes: i.scopes,
    tenantName: i.tenantName,
  };
}

export class AuthService {
  private readonly key: Uint8Array;
  private readonly box: SecretBox;
  private readonly cache = new Map<string, { identity: Identity; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly bop: BopClient,
    sessionSecret: string,
    credentialsKey: string,
  ) {
    this.key = new TextEncoder().encode(sessionSecret);
    this.box = new SecretBox(credentialsKey);
  }

  async issueSession(identity: Identity, ttlSeconds = 12 * 3600): Promise<string> {
    const jwt = await new SignJWT({ ...identity })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(identity.userId)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.key);
    return `${SESSION_PREFIX}${jwt}`;
  }

  async login(email: string, password: string): Promise<{ token: string; me: MeDto }> {
    let access;
    try {
      access = await this.bop.login(email, password);
    } catch (error) {
      throw new AuthError(error instanceof BopError && error.status < 500 ? 401 : 502, 'Invalid e-mail or password');
    }
    const identity = identityFromMe(access.me);
    const existing = await this.credential(identity.tenantId, identity.userId);
    const usable =
      existing !== null &&
      (await this.bop
        .me(existing.token)
        .then(() => true)
        .catch(() => false));
    if (!usable) {
      const created = await this.bop.createApiToken(access.accessToken, 'AI operator', identity.scopes);
      await this.storeCredential(identity, created.token);
    }
    await this.ensureTenant(access.me);
    return { token: await this.issueSession(identity), me: toMeDto(identity) };
  }

  async ensureTenant(me: BopMe): Promise<void> {
    const domain = me.user.email.split('@')[1] ?? '';
    await this.db
      .insert(tenantSettings)
      .values({ tenantId: me.tenant.id, name: me.tenant.name, domain, timezone: me.tenant.settings?.timezone ?? 'UTC' })
      .onConflictDoNothing();
  }

  async storeCredential(identity: Identity, token: string): Promise<void> {
    await this.db
      .insert(userCredentials)
      .values({
        tenantId: identity.tenantId,
        userId: identity.userId,
        email: identity.email,
        name: identity.name,
        role: identity.role,
        scopes: identity.scopes,
        tokenEnc: this.box.encrypt(token),
      })
      .onConflictDoUpdate({
        target: [userCredentials.tenantId, userCredentials.userId],
        set: {
          email: identity.email,
          name: identity.name,
          role: identity.role,
          scopes: identity.scopes,
          tokenEnc: this.box.encrypt(token),
          updatedAt: new Date(),
        },
      });
  }

  async credential(tenantId: string, userId: string): Promise<{ token: string; identity: Identity } | null> {
    const [row] = await this.db
      .select()
      .from(userCredentials)
      .where(and(eq(userCredentials.tenantId, tenantId), eq(userCredentials.userId, userId)));
    if (row === undefined) return null;
    const [tenant] = await this.db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    return {
      token: this.box.decrypt(row.tokenEnc),
      identity: {
        userId: row.userId,
        tenantId: row.tenantId,
        name: row.name,
        email: row.email,
        role: row.role,
        scopes: row.scopes as string[],
        tenantName: tenant?.name ?? '',
      },
    };
  }

  sealSecret(value: string): string {
    return this.box.encrypt(value);
  }

  openSecret(value: string): string {
    return this.box.decrypt(value);
  }

  async authenticate(header: string | undefined): Promise<Identity> {
    if (header === undefined || !/^Bearer\s+/i.test(header))
      throw new AuthError(401, 'Authorization: Bearer <token> is required');
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (token.startsWith(SESSION_PREFIX)) {
      try {
        const { payload } = await jwtVerify(token.slice(SESSION_PREFIX.length), this.key);
        return {
          userId: String(payload['userId']),
          tenantId: String(payload['tenantId']),
          name: String(payload['name']),
          email: String(payload['email']),
          role: String(payload['role']),
          scopes: (payload['scopes'] as string[]) ?? [],
          tenantName: String(payload['tenantName'] ?? ''),
        };
      } catch {
        throw new AuthError(401, 'Session expired or invalid');
      }
    }
    const key = sha256(token);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expires > Date.now()) return cached.identity;
    let me: BopMe;
    try {
      me = await this.bop.me(token);
    } catch (error) {
      throw new AuthError(error instanceof BopError && error.status < 500 ? 401 : 502, 'Invalid business-system token');
    }
    const identity = identityFromMe(me);
    await this.ensureTenant(me);
    const existing = await this.credential(identity.tenantId, identity.userId);
    const usable =
      existing !== null &&
      (existing.token === token ||
        (await this.bop
          .me(existing.token)
          .then(() => true)
          .catch(() => false)));
    if (!usable) {
      if (token.startsWith('bop_pat_')) await this.storeCredential(identity, token);
      else {
        const created = await this.bop.createApiToken(token, 'AI operator', identity.scopes).catch(() => null);
        if (created !== null) await this.storeCredential(identity, created.token);
      }
    }
    this.cache.set(key, { identity, expires: Date.now() + 60_000 });
    return identity;
  }
}
