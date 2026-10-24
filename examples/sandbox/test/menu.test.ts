// The host-mode lobby menu (src/client/menu.ts) in jsdom, over the real index.html markup and a
// lobby double: the signed-out and signed-in views, register (then log in), create, the session
// list with invite codes, joining by Play and by invite code, errors in the status line, logout.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Account,
  CreateSessionRequest,
  CreateSessionResponse,
  JoinResponse,
  MeResponse,
  SessionSummary,
} from '@conduit/lobby-client';
import { LobbyError } from '@conduit/lobby-client';
import { afterEach, describe, expect, it } from 'vitest';
import { type JoinedSession, LobbyMenu, type MenuLobby } from '../src/client/menu.ts';

// Not `new URL(..., import.meta.url)`: Vite rewrites that into a dev-server asset URL.
const INDEX_HTML = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const BODY = /<body>([\s\S]*)<\/body>/.exec(INDEX_HTML)?.[1] ?? '';

function account(username: string, displayName: string): Account {
  return { id: `id-${username}`, username, displayName, createdAt: 1, lastLoginAt: 2 };
}

function summary(id: string, name: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    gameId: 'sandbox',
    name,
    ownerId: 'id-owner',
    visibility: 'public',
    maxPlayers: 4,
    state: 'created',
    memberCount: 1,
    members: [],
    createdAt: 1,
    lastActiveAt: 1,
    ...extra,
  };
}

/** Records every call; each method answers from the fields below. */
class FakeLobby implements MenuLobby {
  readonly calls: unknown[][] = [];
  signedIn: Account | null = null;
  sessions: SessionSummary[] = [];
  failJoin: LobbyError | null = null;
  failCreate: LobbyError | null = null;
  /** Holds the next `listSessions` until `release()`. */
  hold: { promise: Promise<void>; release(): void } | null = null;

  async register(username: string, password: string, displayName?: string): Promise<Account> {
    this.calls.push(['register', username, password, displayName]);
    return account(username.toLowerCase(), displayName ?? username);
  }

  async login(username: string, password: string): Promise<Account> {
    this.calls.push(['login', username, password]);
    this.signedIn = account(username.toLowerCase(), username === 'alice' ? 'Alice' : username);
    return this.signedIn;
  }

  async logout(): Promise<void> {
    this.calls.push(['logout']);
    this.signedIn = null;
  }

  async me(): Promise<MeResponse> {
    this.calls.push(['me']);
    if (this.signedIn === null) throw new LobbyError('unauthorized', 401, 'login required');
    return { account: this.signedIn, friends: [], invites: [] };
  }

  async listSessions(gameId?: string): Promise<SessionSummary[]> {
    this.calls.push(['listSessions', gameId]);
    await this.hold?.promise;
    return this.sessions;
  }

  async createSession(input: CreateSessionRequest): Promise<CreateSessionResponse> {
    this.calls.push(['createSession', input]);
    if (this.failCreate !== null) throw this.failCreate;
    const session = summary('01CREATED', input.name, { inviteCode: 'BCDF1234' });
    this.sessions = [session, ...this.sessions];
    return { session, inviteCode: 'BCDF1234' };
  }

  async join(id: string, inviteCode?: string): Promise<JoinResponse> {
    this.calls.push(['join', id, inviteCode]);
    if (this.failJoin !== null) throw this.failJoin;
    return { token: 'token', wsUrl: `ws://localhost/session/${id}` };
  }

  holdList(): void {
    let release = (): void => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hold = { promise, release: () => release() };
  }
}

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} missing`);
  return el as T;
};

function fill(formId: string, values: Record<string, string>): void {
  const form = byId<HTMLFormElement>(formId);
  for (const [name, value] of Object.entries(values)) {
    (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = value;
  }
}

function submit(formId: string): void {
  byId(formId).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

/** Resolves once the menu is idle again (every lobby call runs with `aria-busy="true"`). */
async function settled(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (byId('menu').getAttribute('aria-busy') !== 'true') return;
  }
  throw new Error('the menu stayed busy');
}

describe('LobbyMenu', () => {
  let menu: LobbyMenu | null = null;

  afterEach(() => {
    menu?.dispose();
    menu = null;
    document.body.innerHTML = '';
    delete document.body.dataset['view'];
  });

  function setup(
    lobby: FakeLobby,
    invite?: { sessionId: string; code: string },
  ): { joined: JoinedSession[] } {
    document.body.innerHTML = BODY;
    const joined: JoinedSession[] = [];
    menu = new LobbyMenu(document, {
      lobby,
      gameId: 'sandbox',
      invite,
      onJoin: (session) => joined.push(session),
    });
    return { joined };
  }

  it('starts signed out on a 401, registers and logs in, then lists the game sessions with their invite codes', async () => {
    const lobby = new FakeLobby();
    lobby.sessions = [
      summary('01MINE', 'mine', { inviteCode: 'BCDF1234', visibility: 'private' }),
      summary('01PUBLIC', 'open game', { memberCount: 2, state: 'running' }),
    ];
    setup(lobby);
    expect(byId('menu').hidden).toBe(true);
    await menu?.start();
    expect(byId('menu').hidden).toBe(false);
    expect(document.body.dataset['view']).toBe('menu');
    expect(byId('menu-signed-out').hidden).toBe(false);
    expect(byId('menu-signed-in').hidden).toBe(true);
    expect(byId('menu-status').textContent).toBe('');

    fill('register', { username: ' alice ', password: ' pass word ', displayName: 'Alice' });
    submit('register');
    await settled();
    // The username is trimmed; the password is sent as typed.
    expect(lobby.calls).toEqual([
      ['me'],
      ['register', 'alice', ' pass word ', 'Alice'],
      ['login', 'alice', ' pass word '],
      ['listSessions', 'sandbox'],
    ]);
    expect(byId('menu-signed-out').hidden).toBe(true);
    expect(byId('menu-signed-in').hidden).toBe(false);
    expect(byId('menu-account').textContent).toBe('Alice (alice)');
    const items = [...byId('sessions').querySelectorAll('li')];
    expect(items.map((li) => ({ ...li.dataset }))).toEqual([
      { sessionId: '01MINE', state: 'created', inviteCode: 'BCDF1234' },
      { sessionId: '01PUBLIC', state: 'running' },
    ]);
    expect(items[0]?.textContent).toContain('invite BCDF1234');
    expect(items[1]?.textContent).toContain('open game running · 2/4 · public');
    expect(items.every((li) => li.querySelector('button')?.textContent === 'Play')).toBe(true);
  });

  it('shows the signed-in view at once for a logged-in page, and the forms again after logout', async () => {
    const lobby = new FakeLobby();
    lobby.signedIn = account('bob', 'Bob');
    setup(lobby);
    await menu?.start();
    expect(byId('menu-signed-in').hidden).toBe(false);
    expect(byId('menu-account').textContent).toBe('Bob (bob)');
    expect(lobby.calls).toEqual([['me'], ['listSessions', 'sandbox']]);

    byId('logout').click();
    await settled();
    expect(byId('menu-signed-in').hidden).toBe(true);
    expect(byId('menu-signed-out').hidden).toBe(false);
    expect(byId('sessions').childElementCount).toBe(0);
  });

  it('creates a session and lists it with its invite code; a refused create shows the error and its field', async () => {
    const lobby = new FakeLobby();
    lobby.signedIn = account('alice', 'Alice');
    setup(lobby);
    await menu?.start();

    fill('create', { name: ' duo ', visibility: 'private', maxPlayers: '2' });
    submit('create');
    await settled();
    expect(lobby.calls.at(-2)).toEqual([
      'createSession',
      { gameId: 'sandbox', name: 'duo', visibility: 'private', maxPlayers: 2 },
    ]);
    expect(lobby.calls.at(-1)).toEqual(['listSessions', 'sandbox']);
    expect(byId('menu-status').textContent).toBe('created duo: invite code BCDF1234');
    expect(byId('menu-status').dataset['error']).toBeUndefined();
    expect(byId('sessions').querySelector('li')?.dataset['inviteCode']).toBe('BCDF1234');

    lobby.failCreate = new LobbyError('validation', 400, 'name is required', { field: 'name' });
    fill('create', { name: '' });
    submit('create');
    await settled();
    expect(byId('menu-status').textContent).toBe('name is required (name)');
    expect(byId('menu-status').dataset['error']).toBe('validation');
  });

  it('Play joins a listed session and hands it over with its invite code; the menu hides', async () => {
    const lobby = new FakeLobby();
    lobby.signedIn = account('alice', 'Alice');
    lobby.sessions = [summary('01MINE', 'mine', { inviteCode: 'BCDF1234' })];
    const { joined } = setup(lobby);
    await menu?.start();

    byId('sessions').querySelector('button')?.click();
    await settled();
    expect(lobby.calls.at(-1)).toEqual(['join', '01MINE', undefined]);
    expect(joined).toEqual([{ id: '01MINE', inviteCode: 'BCDF1234' }]);
    expect(byId('menu').hidden).toBe(true);
    expect(document.body.dataset['view']).toBe('game');
    // Disposed: the menu no longer reacts.
    byId('sessions').querySelector('button')?.click();
    await settled();
    expect(joined).toHaveLength(1);
  });

  it('joins by session id and invite code (prefilled from an invite link); a refused join stays in the menu', async () => {
    const lobby = new FakeLobby();
    lobby.signedIn = account('bob', 'Bob');
    const { joined } = setup(lobby, { sessionId: '01INVITED', code: 'bcdf1234' });
    await menu?.start();
    const form = byId<HTMLFormElement>('join');
    expect((form.elements.namedItem('session') as HTMLInputElement).value).toBe('01INVITED');
    expect((form.elements.namedItem('code') as HTMLInputElement).value).toBe('bcdf1234');

    lobby.failJoin = new LobbyError('bad_invite', 403, 'invalid invite code');
    submit('join');
    await settled();
    expect(lobby.calls.at(-1)).toEqual(['join', '01INVITED', 'bcdf1234']);
    expect(joined).toEqual([]);
    expect(byId('menu').hidden).toBe(false);
    expect(byId('menu-status').textContent).toBe('invalid invite code');
    expect(byId('menu-status').dataset['error']).toBe('bad_invite');

    lobby.failJoin = null;
    submit('join');
    await settled();
    // Sent as typed; handed over as issued, for the invite panel.
    expect(lobby.calls.at(-1)).toEqual(['join', '01INVITED', 'bcdf1234']);
    expect(joined).toEqual([{ id: '01INVITED', inviteCode: 'BCDF1234' }]);
  });

  it('joins by session id alone (a public, a friends or a member session) without a code', async () => {
    const lobby = new FakeLobby();
    lobby.signedIn = account('bob', 'Bob');
    const { joined } = setup(lobby);
    await menu?.start();
    fill('join', { session: ' 01OPEN ', code: ' ' });
    submit('join');
    await settled();
    expect(lobby.calls.at(-1)).toEqual(['join', '01OPEN', undefined]);
    expect(joined).toEqual([{ id: '01OPEN', inviteCode: undefined }]);
  });

  it('disables its controls while a lobby call is in flight and ignores submits meanwhile', async () => {
    const lobby = new FakeLobby();
    lobby.signedIn = account('alice', 'Alice');
    setup(lobby);
    await menu?.start();
    lobby.holdList();
    byId('refresh').click();
    expect(byId('menu').getAttribute('aria-busy')).toBe('true');
    expect(byId<HTMLButtonElement>('refresh').disabled).toBe(true);
    expect(byId<HTMLInputElement>('create-name').disabled).toBe(true);
    submit('create');
    lobby.hold?.release();
    await settled();
    expect(lobby.calls.filter((call) => call[0] === 'createSession')).toEqual([]);
    expect(byId<HTMLButtonElement>('refresh').disabled).toBe(false);
  });
});
