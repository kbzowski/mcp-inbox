export {};

interface SearchMessage {
  type: 'search';
  query: string;
  mcpDir: string;
  model?: string;
}

interface OpenFolderMessage {
  type: 'openFolder';
  folder: string;
}

interface OpenEmailMessage {
  type: 'openEmail';
  message_id: string;
  folder: string;
}

type ExtensionMessage = SearchMessage | OpenFolderMessage | OpenEmailMessage;

// Thunderbird-specific APIs not in @types/webextension-polyfill
interface MailFolder {
  accountId: string;
  path: string;
  name: string;
  subFolders?: MailFolder[];
}

interface MailAccount {
  id: string;
  name: string;
  folders: MailFolder[];
}

interface MessengerExtras {
  accounts: { list(): Promise<MailAccount[]> };
  messages: {
    query(q: {
      headerMessageId?: string;
    }): Promise<{ messages: Array<{ id: number; folder: MailFolder }> }>;
  };
  mailTabs: {
    update(tabId: number, props: { displayedFolder: MailFolder }): Promise<void>;
    setSelectedMessages(tabId: number, messageIds: number[]): Promise<void>;
  };
}

declare const messenger: typeof browser & MessengerExtras;

// ── Persistent search window (singleton) ─────────────────────────────────────

let searchWindowId: number | null = null;

browser.browserAction.onClicked.addListener(() => {
  void openSearchWindow();
});

async function openSearchWindow(): Promise<void> {
  if (searchWindowId !== null) {
    try {
      await browser.windows.update(searchWindowId, { focused: true });
      return;
    } catch {
      searchWindowId = null;
    }
  }
  const win = await browser.windows.create({
    url: browser.runtime.getURL('dist/sidebar/sidebar.html'),
    type: 'popup',
    width: 440,
    height: 620,
  });
  searchWindowId = win.id ?? null;
}

browser.windows.onRemoved.addListener((windowId) => {
  if (windowId === searchWindowId) searchWindowId = null;
});

// ── Native messaging port ─────────────────────────────────────────────────────

type NativePort = ReturnType<typeof browser.runtime.connectNative>;

let port: NativePort | null = null;
const pendingResolvers: Array<(value: unknown) => void> = [];

function getPort(): NativePort {
  if (port) return port;

  port = browser.runtime.connectNative('claude_email_search');

  port.onMessage.addListener((msg: unknown) => {
    const resolve = pendingResolvers.shift();
    if (resolve) resolve(msg);
  });

  port.onDisconnect.addListener(() => {
    port = null;
    const err = browser.runtime.lastError?.message ?? 'Native host disconnected';
    for (const resolve of pendingResolvers.splice(0)) {
      resolve({ type: 'result', error: err, emails: [] });
    }
  });

  return port;
}

browser.runtime.onMessage.addListener((msg: ExtensionMessage): Promise<unknown> | undefined => {
  if (msg.type === 'search') {
    return new Promise((resolve) => {
      pendingResolvers.push(resolve);
      try {
        getPort().postMessage({
          type: 'search',
          query: msg.query,
          mcpDir: msg.mcpDir,
          model: msg.model,
        });
      } catch (err) {
        pendingResolvers.pop();
        resolve({ type: 'result', error: String(err), emails: [] });
      }
    });
  }

  if (msg.type === 'openEmail') {
    void openEmail(msg.message_id, msg.folder);
    return undefined;
  }

  if (msg.type === 'openFolder') {
    void openFolder(msg.folder);
    return undefined;
  }

  return undefined;
});

async function openEmail(messageId: string, folder: string): Promise<void> {
  try {
    const bareId = messageId.replace(/^<|>$/g, '');
    const results = await messenger.messages.query({ headerMessageId: bareId });
    const tbMsg = results.messages[0];
    if (tbMsg) {
      const tabs = await browser.tabs.query({ type: 'mail' } as Parameters<
        typeof browser.tabs.query
      >[0]);
      if (tabs[0]?.id !== undefined) {
        await messenger.mailTabs.update(tabs[0].id, { displayedFolder: tbMsg.folder });
        await messenger.mailTabs.setSelectedMessages(tabs[0].id, [tbMsg.id]);
      }
      return;
    }
  } catch {
    // fall through to folder fallback
  }
  await openFolder(folder);
}

async function openFolder(folderPath: string): Promise<void> {
  try {
    const accounts = await messenger.accounts.list();
    for (const account of accounts) {
      const folder = findFolder(account.folders, folderPath);
      if (folder) {
        const tabs = await browser.tabs.query({ type: 'mail' } as Parameters<
          typeof browser.tabs.query
        >[0]);
        if (tabs.length > 0 && tabs[0]?.id !== undefined) {
          await messenger.mailTabs.update(tabs[0].id, { displayedFolder: folder });
        }
        return;
      }
    }
  } catch {
    // Non-critical — user can navigate manually
  }
}

function findFolder(folders: MailFolder[], path: string): MailFolder | null {
  for (const f of folders) {
    if (f.path === path || f.name === path) return f;
    if (f.subFolders) {
      const found = findFolder(f.subFolders, path);
      if (found) return found;
    }
  }
  return null;
}
