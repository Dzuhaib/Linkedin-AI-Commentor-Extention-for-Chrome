// CommentAI — Content Script (v2 — robust LinkedIn detection)
// Strategy:
//   1. Intercept clicks on LinkedIn's comment buttons → inject button after box opens
//   2. MutationObserver as backup for any contenteditable that appears
//   3. Multiple insertion methods to guarantee text enters the Quill editor

(function () {
  'use strict';

  const PFX = 'cai';
  let isGenerating  = false;
  let activeModal   = null;
  let currentTone   = 'professional';
  let currentLength = 'medium';

  // ─── Selectors ───────────────────────────────────────────────────────────────
  // All known LinkedIn comment button selectors (covers many LinkedIn versions)
  const LI_COMMENT_BTN_SEL = [
    'button.comment-button',
    'button[aria-label*="comment" i]',
    'button[aria-label*="Comment" i]',
    '[data-control-name="comment"]',
    '.social-actions__button--comment',
    '.feed-shared-social-action-bar__action-btn',
    'li.social-action-bar__action-btn button',
    'button.react-button__trigger[aria-label*="comment" i]',
    '.comments-comment-social-bar button',
    'button[data-urn*="comment"]',
    // Reply buttons inside comment threads
    'button.comments-comment-item__reply-action-bar-toggle',
    'button[aria-label*="Reply" i]',
  ].join(', ');

  // ─── Initialise ─────────────────────────────────────────────────────────────

  async function init() {
    const s = await getSettings();
    currentTone   = s.defaultTone   || 'professional';
    currentLength = s.commentLength || 'medium';

    // 1. Scan page on load (handles pre-existing boxes)
    scanAndInject();

    // 2. MutationObserver — catches any new contenteditable added to DOM
    const obs = new MutationObserver(debounce(scanAndInject, 300));
    obs.observe(document.body, { childList: true, subtree: true });

    // 3. Click interceptor — fires BEFORE LinkedIn opens the box,
    //    then we retry after short delays to catch the newly opened editor.
    document.addEventListener('click', onPageClick, true);
  }

  // ─── Click Interceptor ───────────────────────────────────────────────────────
  // When the user clicks LinkedIn's comment icon we schedule retries so we
  // inject our button as soon as the editor DOM appears.

  function onPageClick(e) {
    const commentBtn = e.target.closest(LI_COMMENT_BTN_SEL);
    if (!commentBtn) return;

    // Retry at 300 ms, 600 ms, 1 s, 1.8 s to handle slow renders
    [300, 600, 1000, 1800].forEach(delay =>
      setTimeout(scanAndInject, delay)
    );
  }

  // ─── Scan & Inject ───────────────────────────────────────────────────────────

  function scanAndInject() {
    // ── Strategy A: known LinkedIn class names ──
    const knownWrappers = [
      '.comments-comment-texteditor',
      '.comments-comment-box__form',
      '.comments-comment-box',
    ];
    knownWrappers.forEach(sel => {
      document.querySelectorAll(sel).forEach(wrap => {
        tryInject(wrap, wrap.querySelector('.ql-editor[contenteditable]') ||
                        wrap.querySelector('[contenteditable="true"]'));
      });
    });

    // ── Strategy B: any visible Quill editor on the page ──
    document.querySelectorAll('.ql-editor[contenteditable="true"]').forEach(editor => {
      // Walk up to find a sensible injection container
      const wrap = editor.closest('.comments-comment-texteditor')
                || editor.closest('.comments-comment-box')
                || editor.closest('.comments-comment-box__form')
                || editor.closest('form')
                || editor.parentElement?.parentElement
                || editor.parentElement;
      if (wrap) tryInject(wrap, editor);
    });

    // ── Strategy C: any [contenteditable] inside a comments section ──
    document.querySelectorAll('[contenteditable="true"]').forEach(editor => {
      const inComments = editor.closest('.comments-container')
                      || editor.closest('[id*="comment" i]')
                      || editor.closest('[class*="comment" i]')
                      || editor.closest('[aria-label*="comment" i]');
      if (!inComments) return;
      const wrap = editor.closest('form')
                || editor.parentElement?.parentElement
                || editor.parentElement;
      if (wrap) tryInject(wrap, editor);
    });
  }

  function tryInject(wrap, editor) {
    if (!wrap || !editor) return;
    // Skip if already injected or editor is hidden
    if (wrap.querySelector(`.${PFX}-btn`)) return;
    if (editor.offsetParent === null) return; // hidden

    injectButton(wrap, editor);
  }

  // ─── Button Injection ────────────────────────────────────────────────────────

  function injectButton(wrap, editor) {
    // ── Button wrapper ──
    const group = document.createElement('div');
    group.className = `${PFX}-btn-group`;

    // ── Main button: shows 3-option modal ──
    const btn = document.createElement('button');
    btn.className = `${PFX}-btn`;
    btn.type      = 'button';
    btn.title     = 'Generate 3 AI comment options';
    btn.innerHTML = `<span class="${PFX}-btn-sparkle">✦</span><span class="${PFX}-btn-label">AI Comment</span>`;
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      handleButtonClick(btn, wrap, editor);
    });

    // ── Quick button: 3-5 word phrase, direct insert, no modal ──
    const quickBtn = document.createElement('button');
    quickBtn.className = `${PFX}-btn ${PFX}-btn--quick`;
    quickBtn.type      = 'button';
    quickBtn.title     = 'Instantly insert a 3-5 word reaction based on this post';
    quickBtn.innerHTML = `<span class="${PFX}-btn-sparkle">⚡</span><span class="${PFX}-btn-label">Quick</span>`;
    quickBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      handleQuickClick(quickBtn, wrap, editor);
    });

    group.appendChild(btn);
    group.appendChild(quickBtn);

    const target = editor.parentElement || wrap;
    target.appendChild(group);
  }

  // ─── Post Text Extraction ────────────────────────────────────────────────────

  function extractPostText(editorOrWrap) {
    let el       = editorOrWrap;
    let attempts = 0;

    const selectors = [
      // Current LinkedIn feed selectors (2024–2025)
      '.feed-shared-update-v2__description .update-components-text',
      '.update-components-text__text-view span',
      '.update-components-text',
      '.feed-shared-text',
      '.feed-shared-text-view span[dir]',
      '.attributed-text-segment-list__content',
      '[data-test-id="main-feed-activity-card__commentary"]',
      '.feed-shared-article__description',
      '.update-components-article__meta-link-description',
      // Article / pulse
      '.reader-article-content p',
      'article p',
    ];

    while (el && attempts < 35) {
      for (const sel of selectors) {
        const found = el.querySelector(sel);
        if (found) {
          const text = found.innerText?.trim() || '';
          if (text.length > 15) return text.slice(0, 2500);
        }
      }
      el = el.parentElement;
      attempts++;
    }
    return '';
  }

  // ─── Main Generation Flow ────────────────────────────────────────────────────

  async function handleButtonClick(btn, wrap, editor) {
    if (isGenerating) return;

    const settings = await getSettings();
    if (!settings.apiKey) {
      showToast('⚠️ Add your OpenAI API key in the CommentAI popup (click the ✦ icon).', 'error');
      return;
    }

    isGenerating = true;
    setButtonLoading(btn, true);

    try {
      const postText = extractPostText(wrap);

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action:   'generateComments',
            postText,
            tone:     settings.defaultTone   || 'professional',
            length:   settings.commentLength || 'medium',
            apiKey:   settings.apiKey,
            model:    settings.model || 'gpt-4o-mini',
            count:    3
          },
          res => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(res);
          }
        );
      });

      if (!response?.success) throw new Error(response?.error || 'Unknown error');

      currentTone   = settings.defaultTone   || 'professional';
      currentLength = settings.commentLength || 'medium';

      showModal(response.data, wrap, editor, settings);
      chrome.runtime.sendMessage({ action: 'incrementStats' });

    } catch (err) {
      console.error('[CommentAI]', err);
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      isGenerating = false;
      setButtonLoading(btn, false);
    }
  }

  // ─── Quick Comment Handler (1 line, direct insert, no modal) ────────────────

  async function handleQuickClick(btn, wrap, editor) {
    if (isGenerating) return;

    const settings = await getSettings();
    if (!settings.apiKey) {
      showToast('⚠️ Add your OpenAI API key in the CommentAI popup (click the ✦ icon).', 'error');
      return;
    }

    isGenerating = true;
    setButtonLoading(btn, true, true);

    try {
      const postText = extractPostText(wrap);

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action:   'generateComments',
            postText,
            tone:     settings.defaultTone || 'professional',
            length:   'micro',  // 3-5 words only
            apiKey:   settings.apiKey,
            model:    settings.model || 'gpt-4o-mini',
            count:    1
          },
          res => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(res);
          }
        );
      });

      if (!response?.success) throw new Error(response?.error || 'Unknown error');

      const comment = response.data[0];
      insertComment(comment, editor);
      chrome.runtime.sendMessage({ action: 'incrementStats' });

    } catch (err) {
      console.error('[CommentAI Quick]', err);
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      isGenerating = false;
      setButtonLoading(btn, false, true);
    }
  }

  // ─── Modal ───────────────────────────────────────────────────────────────────

  function showModal(comments, wrap, editor, settings) {
    removeModal();

    const overlay = document.createElement('div');
    overlay.className = `${PFX}-overlay`;
    overlay.innerHTML = buildModalHTML(comments, settings);
    document.body.appendChild(overlay);
    activeModal = overlay;

    requestAnimationFrame(() => {
      overlay.classList.add(`${PFX}-overlay--in`);
      overlay.querySelector(`.${PFX}-modal`)?.classList.add(`${PFX}-modal--in`);
    });

    // Close overlay click & ESC
    overlay.addEventListener('click', e => { if (e.target === overlay) removeModal(); });
    const onKey = e => { if (e.key === 'Escape') { removeModal(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    // Close button
    overlay.querySelector(`.${PFX}-close-btn`)?.addEventListener('click', removeModal);

    // "Use" buttons
    overlay.querySelectorAll(`.${PFX}-use-btn`).forEach(b => {
      b.addEventListener('click', () => {
        const comment = b.closest(`.${PFX}-card`)?.dataset?.comment;
        if (comment) insertComment(comment, editor);
        removeModal();
      });
    });

    // Card highlight
    overlay.querySelectorAll(`.${PFX}-card`).forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest(`.${PFX}-use-btn`)) return;
        overlay.querySelectorAll(`.${PFX}-card`).forEach(c => c.classList.remove(`${PFX}-card--selected`));
        card.classList.add(`${PFX}-card--selected`);
      });
    });

    // Tone pills → regenerate
    overlay.querySelectorAll(`.${PFX}-tone-pill`).forEach(pill => {
      pill.addEventListener('click', async () => {
        overlay.querySelectorAll(`.${PFX}-tone-pill`).forEach(p => p.classList.remove(`${PFX}-tone-pill--active`));
        pill.classList.add(`${PFX}-tone-pill--active`);
        currentTone = pill.dataset.tone;
        await regenerateInModal(overlay, wrap, editor, settings);
      });
    });

    // Regenerate button
    overlay.querySelector(`.${PFX}-regen-btn`)?.addEventListener('click', async () => {
      await regenerateInModal(overlay, wrap, editor, settings);
    });
  }

  function buildModalHTML(comments, settings) {
    const tones  = ['professional', 'enthusiastic', 'thoughtful', 'curious', 'supportive', 'concise'];
    const active = currentTone || settings.defaultTone || 'professional';

    const pillsHTML = tones.map(t =>
      `<button class="${PFX}-tone-pill${t === active ? ` ${PFX}-tone-pill--active` : ''}" data-tone="${t}">${capFirst(t)}</button>`
    ).join('');

    const cardsHTML = comments.map((c, i) => `
      <div class="${PFX}-card" data-comment="${escHtml(c)}">
        <div class="${PFX}-card-num">${i + 1}</div>
        <p class="${PFX}-card-text">${escHtml(c)}</p>
        <button class="${PFX}-use-btn">Use This Comment →</button>
      </div>`
    ).join('');

    return `
      <div class="${PFX}-modal" role="dialog" aria-modal="true">
        <div class="${PFX}-modal-header">
          <div class="${PFX}-modal-title"><span class="${PFX}-logo-spark">✦</span> CommentAI</div>
          <button class="${PFX}-close-btn" title="Close">✕</button>
        </div>
        <div class="${PFX}-tone-row">
          <span class="${PFX}-tone-label">Tone:</span>${pillsHTML}
        </div>
        <div class="${PFX}-cards-list">${cardsHTML}</div>
        <div class="${PFX}-modal-footer">
          <button class="${PFX}-regen-btn">↺  Regenerate</button>
          <span class="${PFX}-footer-note">Powered by OpenAI · Your key, your data</span>
        </div>
      </div>`;
  }

  async function regenerateInModal(overlay, wrap, editor, settings) {
    const regenBtn  = overlay.querySelector(`.${PFX}-regen-btn`);
    const cardsList = overlay.querySelector(`.${PFX}-cards-list`);

    regenBtn.disabled    = true;
    regenBtn.textContent = '↺ Regenerating…';
    cardsList.classList.add(`${PFX}-cards-list--loading`);

    try {
      const postText = extractPostText(wrap);
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action:   'generateComments',
            postText,
            tone:     currentTone   || settings.defaultTone   || 'professional',
            length:   currentLength || settings.commentLength || 'medium',
            apiKey:   settings.apiKey,
            model:    settings.model || 'gpt-4o-mini',
            count:    3
          },
          res => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(res);
          }
        );
      });

      if (!response?.success) throw new Error(response?.error);

      cardsList.innerHTML = response.data.map((c, i) => `
        <div class="${PFX}-card" data-comment="${escHtml(c)}">
          <div class="${PFX}-card-num">${i + 1}</div>
          <p class="${PFX}-card-text">${escHtml(c)}</p>
          <button class="${PFX}-use-btn">Use This Comment →</button>
        </div>`
      ).join('');

      cardsList.querySelectorAll(`.${PFX}-use-btn`).forEach(b => {
        b.addEventListener('click', () => {
          const comment = b.closest(`.${PFX}-card`)?.dataset?.comment;
          if (comment) insertComment(comment, editor);
          removeModal();
        });
      });

      cardsList.querySelectorAll(`.${PFX}-card`).forEach(card => {
        card.addEventListener('click', e => {
          if (e.target.closest(`.${PFX}-use-btn`)) return;
          cardsList.querySelectorAll(`.${PFX}-card`).forEach(c => c.classList.remove(`${PFX}-card--selected`));
          card.classList.add(`${PFX}-card--selected`);
        });
      });

      chrome.runtime.sendMessage({ action: 'incrementStats' });

    } catch (err) {
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      regenBtn.disabled    = false;
      regenBtn.textContent = '↺  Regenerate';
      cardsList.classList.remove(`${PFX}-cards-list--loading`);
    }
  }

  function removeModal() {
    if (!activeModal) return;
    activeModal.classList.remove(`${PFX}-overlay--in`);
    activeModal.querySelector(`.${PFX}-modal`)?.classList.remove(`${PFX}-modal--in`);
    const ref = activeModal;
    setTimeout(() => ref.remove(), 320);
    activeModal = null;
  }

  // ─── Comment Insertion (3-method waterfall) ──────────────────────────────────

  function insertComment(text, editor) {
    if (!editor) {
      showToast('⚠️ Could not find the comment box.', 'error');
      return;
    }

    // Make sure editor is visible and focused
    editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
    editor.focus();

    let inserted = false;

    // ── Method 1: execCommand (best for Quill) ──
    try {
      document.execCommand('selectAll', false, null);
      inserted = document.execCommand('insertText', false, text);
    } catch (_) {}

    // ── Method 2: InputEvent (modern browsers) ──
    if (!inserted || !editorContains(editor, text)) {
      try {
        editor.focus();
        const ev = new InputEvent('input', {
          bubbles:  true,
          cancelable: true,
          data:     text,
          inputType: 'insertText'
        });
        // Clear first
        editor.innerHTML = '';
        editor.dispatchEvent(new Event('focus', { bubbles: true }));
        document.execCommand('insertText', false, text);
        if (!editorContains(editor, text)) throw new Error('retry');
      } catch (_) {}
    }

    // ── Method 3: Direct DOM fallback ──
    if (!editorContains(editor, text)) {
      editor.innerHTML = `<p>${text.replace(/\n/g, '</p><p>')}</p>`;
      ['input', 'change', 'keyup', 'keydown'].forEach(evt =>
        editor.dispatchEvent(new Event(evt, { bubbles: true }))
      );
      // Trigger React/Quill synthetic events
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    }

    // Move caret to end so LinkedIn enables the Post button
    try {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
    } catch (_) {}

    showToast('✓ Comment inserted! Click Post to publish.', 'success');
  }

  function editorContains(editor, text) {
    return editor.innerText?.trim().includes(text.slice(0, 30).trim());
  }

  // ─── Button State ────────────────────────────────────────────────────────────

  function setButtonLoading(btn, loading, isQuick = false) {
    btn.disabled  = loading;
    btn.classList.toggle(`${PFX}-btn--loading`, loading);
    if (isQuick) {
      btn.innerHTML = loading
        ? `<span class="${PFX}-spinner"></span><span class="${PFX}-btn-label">Writing…</span>`
        : `<span class="${PFX}-btn-sparkle">⚡</span><span class="${PFX}-btn-label">Quick</span>`;
    } else {
      btn.innerHTML = loading
        ? `<span class="${PFX}-spinner"></span><span class="${PFX}-btn-label">Generating…</span>`
        : `<span class="${PFX}-btn-sparkle">✦</span><span class="${PFX}-btn-label">AI Comment</span>`;
    }
  }

  // ─── Toast ───────────────────────────────────────────────────────────────────

  function showToast(message, type = 'info') {
    document.querySelectorAll(`.${PFX}-toast`).forEach(t => t.remove());
    const toast = document.createElement('div');
    toast.className = `${PFX}-toast ${PFX}-toast--${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add(`${PFX}-toast--show`));
    setTimeout(() => {
      toast.classList.remove(`${PFX}-toast--show`);
      setTimeout(() => toast.remove(), 350);
    }, 4000);
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  function getSettings() {
    return new Promise(r =>
      chrome.storage.sync.get(
        { apiKey: '', model: 'gpt-4o-mini', defaultTone: 'professional', commentLength: 'medium' }, r
      )
    );
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function capFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ─── Boot ────────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
