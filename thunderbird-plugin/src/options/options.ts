export {};

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Updated when Anthropic releases new models — user can always type a custom ID.
const KNOWN_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'opus',
  'sonnet',
  'haiku',
];

const form = document.getElementById('options-form') as HTMLFormElement;
const mcpDirInput = document.getElementById('mcp-dir') as HTMLInputElement;
const modelInput = document.getElementById('model') as HTMLInputElement;
const modelList = document.getElementById('model-list') as HTMLDataListElement;
const statusEl = document.getElementById('status') as HTMLElement;

for (const id of KNOWN_MODELS) {
  const opt = document.createElement('option');
  opt.value = id;
  modelList.appendChild(opt);
}

async function load(): Promise<void> {
  const { mcpDir, model } = (await browser.storage.local.get(['mcpDir', 'model'])) as {
    mcpDir?: string;
    model?: string;
  };
  if (mcpDir) mcpDirInput.value = mcpDir;
  modelInput.value = model ?? DEFAULT_MODEL;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = mcpDirInput.value.trim();
  if (!value) {
    statusEl.textContent = 'Please enter a directory path.';
    statusEl.className = 'error';
    return;
  }
  await browser.storage.local.set({
    mcpDir: value,
    model: modelInput.value.trim() || DEFAULT_MODEL,
  });
  statusEl.textContent = 'Saved.';
  statusEl.className = 'ok';
  setTimeout(() => {
    statusEl.textContent = '';
  }, 2000);
});

void load();
