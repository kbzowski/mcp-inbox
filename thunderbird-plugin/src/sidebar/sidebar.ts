export {};

interface EmailSummary {
  uid: number;
  folder: string;
  message_id: string | null;
  subject: string | null;
  from: string | null;
  date: string | null;
  unseen: boolean;
  has_attachments: boolean;
}

interface SearchResult {
  type: 'result';
  emails: EmailSummary[];
  total_matches: number;
  folder: string;
  query: string;
  error: string | null;
}

const queryInput = document.getElementById('query') as HTMLInputElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLElement;
const resultsEl = document.getElementById('results') as HTMLElement;

function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const isToday =
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
  return isToday
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function renderResults(data: SearchResult): void {
  resultsEl.innerHTML = '';

  if (data.error) {
    resultsEl.innerHTML = `<div class="error">${esc(data.error)}</div>`;
    setStatus('');
    return;
  }

  if (!data.emails || data.emails.length === 0) {
    resultsEl.innerHTML = '<div class="empty">No emails found.</div>';
    setStatus('');
    return;
  }

  setStatus(
    `${data.total_matches} match${data.total_matches !== 1 ? 'es' : ''}, showing ${data.emails.length}`,
  );

  const fragment = document.createDocumentFragment();
  for (const email of data.emails) {
    const card = document.createElement('div');
    card.className = 'card' + (email.unseen ? ' unseen' : '');
    card.innerHTML = `
      <div class="card-top">
        <span class="from">${esc(email.from)}</span>
        <span class="date">${esc(formatDate(email.date))}</span>
      </div>
      <div class="subject">${esc(email.subject ?? '(no subject)')}${email.has_attachments ? ' <span class="att" title="Has attachments">📎</span>' : ''}</div>
      <div class="folder-label">${esc(email.folder)}</div>
    `;
    card.addEventListener('click', () => {
      card.classList.add('opening');
      setTimeout(() => card.classList.remove('opening'), 1500);
      const msg = email.message_id
        ? { type: 'openEmail', message_id: email.message_id, folder: email.folder }
        : { type: 'openFolder', folder: email.folder };
      void browser.runtime.sendMessage(msg);
    });
    fragment.appendChild(card);
  }
  resultsEl.appendChild(fragment);
}

async function doSearch(): Promise<void> {
  const query = queryInput.value.trim();
  if (!query) return;

  const { mcpDir, model } = (await browser.storage.local.get(['mcpDir', 'model'])) as {
    mcpDir?: string;
    model?: string;
  };
  if (!mcpDir) {
    resultsEl.innerHTML =
      '<div class="error">MCP directory not configured. Open <a href="#" id="open-opts">extension options</a> to set it.</div>';
    document.getElementById('open-opts')?.addEventListener('click', (e) => {
      e.preventDefault();
      void browser.runtime.openOptionsPage();
    });
    return;
  }

  setStatus('Searching\u2026');
  resultsEl.innerHTML = '';
  searchBtn.disabled = true;

  try {
    const response = (await browser.runtime.sendMessage({
      type: 'search',
      query,
      mcpDir,
      model: model ?? 'claude-sonnet-4-6',
    })) as SearchResult;
    renderResults(response);
  } catch (err) {
    resultsEl.innerHTML = `<div class="error">${esc(String(err))}</div>`;
    setStatus('');
  } finally {
    searchBtn.disabled = false;
  }
}

searchBtn.addEventListener('click', () => void doSearch());
queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void doSearch();
});
