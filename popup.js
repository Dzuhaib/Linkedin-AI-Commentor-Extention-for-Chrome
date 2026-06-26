// CommentAI — Popup Script
// Handles settings save/load, stats display, and UI interactions

document.addEventListener('DOMContentLoaded', async () => {

  // ─── Element References ──────────────────────────────────────────────────────
  const apiKeyEl    = document.getElementById('apiKey');
  const toggleKey   = document.getElementById('toggleKey');
  const modelEl     = document.getElementById('model');
  const saveBtn     = document.getElementById('saveBtn');
  const saveStatus  = document.getElementById('saveStatus');
  const toneGrid    = document.getElementById('toneGrid');
  const lengthRow   = document.getElementById('lengthRow');
  const statsToday  = document.getElementById('statsToday');
  const statsTotal  = document.getElementById('statsTotal');
  const statsStatus = document.getElementById('statsStatus');

  let selectedTone   = 'professional';
  let selectedLength = 'medium';

  // ─── Load Saved Settings ─────────────────────────────────────────────────────
  const settings = await loadSettings();
  applySettings(settings);

  // ─── Load Stats ──────────────────────────────────────────────────────────────
  loadStats();

  // ─── Toggle API Key Visibility ────────────────────────────────────────────────
  toggleKey.addEventListener('click', () => {
    const isHidden = apiKeyEl.type === 'password';
    apiKeyEl.type  = isHidden ? 'text' : 'password';
    toggleKey.textContent = isHidden ? '🙈' : '👁';
  });

  // ─── Tone Grid ────────────────────────────────────────────────────────────────
  toneGrid.querySelectorAll('.tone-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      toneGrid.querySelectorAll('.tone-btn').forEach(b => b.classList.remove('tone-btn--active'));
      btn.classList.add('tone-btn--active');
      selectedTone = btn.dataset.tone;
    });
  });

  // ─── Length Row ───────────────────────────────────────────────────────────────
  lengthRow.querySelectorAll('.length-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      lengthRow.querySelectorAll('.length-btn').forEach(b => b.classList.remove('length-btn--active'));
      btn.classList.add('length-btn--active');
      selectedLength = btn.dataset.length;
    });
  });

  // ─── Save Settings ────────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    const apiKey = apiKeyEl.value.trim();

    if (!apiKey) {
      showStatus('Please enter your OpenAI API key.', 'error');
      apiKeyEl.focus();
      return;
    }

    if (!apiKey.startsWith('sk-')) {
      showStatus('API key should start with "sk-"', 'error');
      return;
    }

    saveBtn.disabled    = true;
    saveBtn.textContent = 'Saving…';

    try {
      await chrome.storage.sync.set({
        apiKey:        apiKey,
        model:         modelEl.value,
        defaultTone:   selectedTone,
        commentLength: selectedLength
      });

      // Update status badge
      updateStatusBadge(true);
      showStatus('✓ Settings saved!', 'success');

    } catch (err) {
      showStatus('Failed to save: ' + err.message, 'error');
    } finally {
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Save Settings';
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function applySettings(s) {
    apiKeyEl.value = s.apiKey || '';
    modelEl.value  = s.model  || 'gpt-4o-mini';
    selectedTone   = s.defaultTone   || 'professional';
    selectedLength = s.commentLength || 'medium';

    // Highlight active tone
    toneGrid.querySelectorAll('.tone-btn').forEach(btn => {
      btn.classList.toggle('tone-btn--active', btn.dataset.tone === selectedTone);
    });

    // Highlight active length
    lengthRow.querySelectorAll('.length-btn').forEach(btn => {
      btn.classList.toggle('length-btn--active', btn.dataset.length === selectedLength);
    });

    // Show API key status
    updateStatusBadge(!!s.apiKey);
  }

  function updateStatusBadge(hasKey) {
    if (hasKey) {
      statsStatus.textContent = 'Active';
      statsStatus.classList.add('stat-value--green');
    } else {
      statsStatus.textContent = 'No Key';
      statsStatus.classList.remove('stat-value--green');
      statsStatus.style.color = '#f87171';
    }
  }

  async function loadSettings() {
    return new Promise(resolve =>
      chrome.storage.sync.get(
        { apiKey: '', model: 'gpt-4o-mini', defaultTone: 'professional', commentLength: 'medium' },
        resolve
      )
    );
  }

  function loadStats() {
    chrome.runtime.sendMessage({ action: 'getStats' }, response => {
      if (chrome.runtime.lastError) {
        // Background may not be ready yet — read storage directly
        chrome.storage.local.get(['totalComments', 'todayComments', 'lastDate'], result => {
          const today  = new Date().toDateString();
          const isNew  = result.lastDate !== today;
          statsToday.textContent = isNew ? '0' : (result.todayComments || 0);
          statsTotal.textContent = result.totalComments || 0;
        });
        return;
      }
      if (response?.success) {
        statsToday.textContent = response.data.today;
        statsTotal.textContent = response.data.total;
      }
    });
  }

  let statusTimer = null;
  function showStatus(msg, type = 'success') {
    saveStatus.textContent = msg;
    saveStatus.className   = `save-status${type === 'error' ? ' save-status--error' : ''}`;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      saveStatus.textContent = '';
      saveStatus.className   = 'save-status';
    }, 4000);
  }
});
