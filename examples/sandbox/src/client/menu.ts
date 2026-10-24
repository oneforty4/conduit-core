import {
  LobbyError,
  type LobbyClient,
  type SessionSummary,
  type Visibility,
} from '@conduit/lobby-client';

/** The menu's DOM ids (PLAN.md "Sandbox content spec", M5). */
export const MENU_IDS = {
  menu: 'menu',
  status: 'menu-status',
  signedOut: 'menu-signed-out',
  signedIn: 'menu-signed-in',
  account: 'menu-account',
  logout: 'logout',
  register: 'register',
  login: 'login',
  create: 'create',
  join: 'join',
  refresh: 'refresh',
  sessions: 'sessions',
} as const;

/** The parts of `LobbyClient` the menu uses. */
export type MenuLobby = Pick<
  LobbyClient,
  'register' | 'login' | 'logout' | 'me' | 'listSessions' | 'createSession' | 'join'
>;

/** A session the account has just joined (it is a member now). */
export interface JoinedSession {
  id: string;
  /** Known when the menu listed the session or the player typed it; members may share it. */
  inviteCode: string | undefined;
}

export interface LobbyMenuOptions {
  lobby: MenuLobby;
  /** Sessions of this game are listed and created. */
  gameId: string;
  /** Prefills the join form, e.g. from an invite link's `?session=` and `?code=`. */
  invite?: { sessionId: string; code: string } | undefined;
  /** Called once a join succeeded; the menu has hidden itself and the game takes over. */
  onJoin(session: JoinedSession): void;
}

const VISIBILITIES: readonly Visibility[] = ['private', 'friends', 'public'];

function required<T extends HTMLElement>(doc: Document, id: string, type: new () => T): T {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`sandbox menu: #${id} is missing from index.html`);
  if (!(el instanceof type)) throw new Error(`sandbox menu: #${id} is not a ${type.name}`);
  return el;
}

/** A named `<input>` or `<select>` value of `form`, trimmed unless `raw` (passwords are hashed as typed). */
function field(form: HTMLFormElement, name: string, raw = false): string {
  const control = form.elements.namedItem(name);
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
    return raw ? control.value : control.value.trim();
  }
  throw new Error(`sandbox menu: #${form.id} has no field ${name}`);
}

function setField(form: HTMLFormElement, name: string, value: string): void {
  const control = form.elements.namedItem(name);
  if (control instanceof HTMLInputElement) control.value = value;
}

/** `LobbyError`'s message (with the offending field), else the error's own. */
function describeError(err: unknown): { code: string; text: string } {
  if (err instanceof LobbyError) {
    const text = err.field === undefined ? err.message : `${err.message} (${err.field})`;
    return { code: err.code, text };
  }
  return { code: 'error', text: err instanceof Error ? err.message : String(err) };
}

/**
 * The host-mode lobby menu over `#menu` (index.html): `#register` (which also logs in) and
 * `#login` while signed out; while signed in the account and `#logout`, `#create` (name,
 * visibility, max players), `#join` (session id and invite code) and the `#sessions` list, whose
 * entries carry `data-session-id`, `data-state` and, for the owner and members, `data-invite-code`
 * and show a Play button. Joining (a Play button or `#join`) calls `lobby.join`, hides the menu and
 * hands the session to `onJoin`. Failures show in `#menu-status` (`data-error` holds the lobby's
 * error code); every lobby call disables the menu's controls until it settles.
 */
export class LobbyMenu {
  private readonly doc: Document;
  private readonly opts: LobbyMenuOptions;
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly signedOut: HTMLElement;
  private readonly signedIn: HTMLElement;
  private readonly account: HTMLElement;
  private readonly logoutButton: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly forms: {
    register: HTMLFormElement;
    login: HTMLFormElement;
    create: HTMLFormElement;
    join: HTMLFormElement;
  };
  private readonly list: HTMLElement;
  private busy = false;
  private disposed = false;

  constructor(doc: Document, opts: LobbyMenuOptions) {
    this.doc = doc;
    this.opts = opts;
    this.root = required(doc, MENU_IDS.menu, HTMLElement);
    this.status = required(doc, MENU_IDS.status, HTMLElement);
    this.signedOut = required(doc, MENU_IDS.signedOut, HTMLElement);
    this.signedIn = required(doc, MENU_IDS.signedIn, HTMLElement);
    this.account = required(doc, MENU_IDS.account, HTMLElement);
    this.logoutButton = required(doc, MENU_IDS.logout, HTMLButtonElement);
    this.refreshButton = required(doc, MENU_IDS.refresh, HTMLButtonElement);
    this.forms = {
      register: required(doc, MENU_IDS.register, HTMLFormElement),
      login: required(doc, MENU_IDS.login, HTMLFormElement),
      create: required(doc, MENU_IDS.create, HTMLFormElement),
      join: required(doc, MENU_IDS.join, HTMLFormElement),
    };
    this.list = required(doc, MENU_IDS.sessions, HTMLElement);
    if (opts.invite !== undefined) {
      setField(this.forms.join, 'session', opts.invite.sessionId);
      setField(this.forms.join, 'code', opts.invite.code);
    }
    this.forms.register.addEventListener('submit', this.onRegister);
    this.forms.login.addEventListener('submit', this.onLogin);
    this.forms.create.addEventListener('submit', this.onCreate);
    this.forms.join.addEventListener('submit', this.onJoinForm);
    this.logoutButton.addEventListener('click', this.onLogout);
    this.refreshButton.addEventListener('click', this.onRefresh);
    this.list.addEventListener('click', this.onListClick);
  }

  /**
   * Shows the menu and asks the lobby who is signed in (`GET /me`, answered 401 without a login
   * cookie): the signed-in view with the session list, or the register and login forms.
   */
  async start(): Promise<void> {
    this.root.hidden = false;
    this.doc.body.dataset['view'] = 'menu';
    await this.run(async () => {
      try {
        const me = await this.opts.lobby.me();
        this.showSignedIn(me.account.displayName, me.account.username);
      } catch (err) {
        if (err instanceof LobbyError && err.code === 'unauthorized') {
          this.showSignedOut();
          return;
        }
        throw err;
      }
      await this.listSessions();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.forms.register.removeEventListener('submit', this.onRegister);
    this.forms.login.removeEventListener('submit', this.onLogin);
    this.forms.create.removeEventListener('submit', this.onCreate);
    this.forms.join.removeEventListener('submit', this.onJoinForm);
    this.logoutButton.removeEventListener('click', this.onLogout);
    this.refreshButton.removeEventListener('click', this.onRefresh);
    this.list.removeEventListener('click', this.onListClick);
  }

  // -------------------------------------------------------------------------------------------

  private readonly onRegister = (event: SubmitEvent): void => {
    event.preventDefault();
    const form = this.forms.register;
    const username = field(form, 'username');
    const password = field(form, 'password', true);
    const displayName = field(form, 'displayName');
    void this.run(async () => {
      const lobby = this.opts.lobby;
      await lobby.register(username, password, displayName === '' ? undefined : displayName);
      const account = await lobby.login(username, password);
      form.reset();
      this.showSignedIn(account.displayName, account.username);
      await this.listSessions();
    });
  };

  private readonly onLogin = (event: SubmitEvent): void => {
    event.preventDefault();
    const form = this.forms.login;
    const username = field(form, 'username');
    const password = field(form, 'password', true);
    void this.run(async () => {
      const account = await this.opts.lobby.login(username, password);
      form.reset();
      this.showSignedIn(account.displayName, account.username);
      await this.listSessions();
    });
  };

  private readonly onLogout = (): void => {
    void this.run(async () => {
      await this.opts.lobby.logout();
      this.showSignedOut();
    });
  };

  private readonly onRefresh = (): void => {
    void this.run(() => this.listSessions());
  };

  private readonly onCreate = (event: SubmitEvent): void => {
    event.preventDefault();
    const form = this.forms.create;
    const visibility = field(form, 'visibility') as Visibility;
    const request = {
      gameId: this.opts.gameId,
      name: field(form, 'name'),
      visibility: VISIBILITIES.includes(visibility) ? visibility : 'private',
      maxPlayers: Number(field(form, 'maxPlayers')),
    };
    void this.run(async () => {
      const created = await this.opts.lobby.createSession(request);
      await this.listSessions();
      this.say(`created ${created.session.name}: invite code ${created.inviteCode}`);
    });
  };

  private readonly onJoinForm = (event: SubmitEvent): void => {
    event.preventDefault();
    const form = this.forms.join;
    const sessionId = field(form, 'session');
    const code = field(form, 'code');
    void this.join(sessionId, code === '' ? undefined : code);
  };

  private readonly onListClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const item = target.closest('li');
    const sessionId = item?.dataset['sessionId'];
    if (sessionId === undefined) return;
    void this.join(sessionId, undefined, item?.dataset['inviteCode']);
  };

  private join(sessionId: string, code: string | undefined, known?: string): Promise<void> {
    return this.run(async () => {
      await this.opts.lobby.join(sessionId, code);
      this.root.hidden = true;
      this.doc.body.dataset['view'] = 'game';
      this.dispose();
      // The lobby takes a code in any case; the one to share is shown as issued (upper case).
      this.opts.onJoin({ id: sessionId, inviteCode: code?.toUpperCase() ?? known });
    });
  }

  private async listSessions(): Promise<void> {
    const sessions = await this.opts.lobby.listSessions(this.opts.gameId);
    this.list.replaceChildren(...sessions.map((s) => this.sessionItem(s)));
  }

  private sessionItem(session: SessionSummary): HTMLLIElement {
    const doc = this.doc;
    const item = doc.createElement('li');
    item.dataset['sessionId'] = session.id;
    item.dataset['state'] = session.state;
    const name = doc.createElement('strong');
    name.textContent = session.name;
    const facts = doc.createElement('span');
    facts.textContent = ` ${session.state} \u{b7} ${session.memberCount}/${session.maxPlayers} \u{b7} ${session.visibility}`;
    item.append(name, facts);
    if (session.inviteCode !== undefined) {
      item.dataset['inviteCode'] = session.inviteCode;
      const invite = doc.createElement('code');
      invite.textContent = `invite ${session.inviteCode} \u{b7} session ${session.id}`;
      item.append(doc.createElement('br'), invite);
    }
    const play = doc.createElement('button');
    play.type = 'button';
    play.textContent = 'Play';
    item.append(' ', play);
    return item;
  }

  private showSignedIn(displayName: string, username: string): void {
    this.account.textContent = `${displayName} (${username})`;
    this.signedOut.hidden = true;
    this.signedIn.hidden = false;
  }

  private showSignedOut(): void {
    this.account.textContent = '';
    this.list.replaceChildren();
    this.signedIn.hidden = true;
    this.signedOut.hidden = false;
  }

  private say(text: string, code?: string): void {
    this.status.textContent = text;
    if (code === undefined) delete this.status.dataset['error'];
    else this.status.dataset['error'] = code;
  }

  /** Runs one lobby action with the controls disabled; a failure is shown, not thrown. */
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    this.say('');
    try {
      await action();
    } catch (err) {
      const { code, text } = describeError(err);
      this.say(text, code);
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.setAttribute('aria-busy', String(busy));
    for (const control of this.root.querySelectorAll('button, input, select')) {
      (control as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled = busy;
    }
  }
}
