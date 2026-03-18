// ==UserScript==
// @name        BF Filter
// @namespace   bf-filter
// @description Filters low-value comments on YC Bookface. Hides "congrats!", "+1", "W", and other fluff.
// @match       https://bookface.ycombinator.com/*
// @version     1.0.0
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @grant       GM_xmlhttpRequest
// @connect     generativelanguage.googleapis.com
// @run-at      document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Settings ──────────────────────────────────────────────────────────
  const DEFAULTS = {
    enabled: true,
    minCharThreshold: 50,
    keywordFilterEnabled: true,
    lengthFilterEnabled: true,
    aiFilterEnabled: false,
    aiApiKey: '',
  };

  function loadSettings() {
    return {
      enabled: GM_getValue('enabled', DEFAULTS.enabled),
      minCharThreshold: GM_getValue('minCharThreshold', DEFAULTS.minCharThreshold),
      keywordFilterEnabled: GM_getValue('keywordFilterEnabled', DEFAULTS.keywordFilterEnabled),
      lengthFilterEnabled: GM_getValue('lengthFilterEnabled', DEFAULTS.lengthFilterEnabled),
      aiFilterEnabled: GM_getValue('aiFilterEnabled', DEFAULTS.aiFilterEnabled),
      aiApiKey: GM_getValue('aiApiKey', DEFAULTS.aiApiKey),
    };
  }

  let settings = loadSettings();

  // ── Menu commands for toggling settings ────────────────────────────────
  GM_registerMenuCommand('Toggle BF Filter (on/off)', () => {
    settings.enabled = !settings.enabled;
    GM_setValue('enabled', settings.enabled);
    alert(`BF Filter: ${settings.enabled ? 'ON' : 'OFF'}`);
    removeAllFilters();
    if (settings.enabled) processAllComments();
  });

  GM_registerMenuCommand('Toggle keyword filter', () => {
    settings.keywordFilterEnabled = !settings.keywordFilterEnabled;
    GM_setValue('keywordFilterEnabled', settings.keywordFilterEnabled);
    alert(`Keyword filter: ${settings.keywordFilterEnabled ? 'ON' : 'OFF'}`);
    removeAllFilters();
    if (settings.enabled) processAllComments();
  });

  GM_registerMenuCommand('Toggle length filter', () => {
    settings.lengthFilterEnabled = !settings.lengthFilterEnabled;
    GM_setValue('lengthFilterEnabled', settings.lengthFilterEnabled);
    alert(`Length filter: ${settings.lengthFilterEnabled ? 'ON' : 'OFF'}`);
    removeAllFilters();
    if (settings.enabled) processAllComments();
  });

  GM_registerMenuCommand('Set min character threshold', () => {
    const val = prompt('Minimum characters:', String(settings.minCharThreshold));
    if (val === null || !Number.isInteger(Number(val)) || Number(val) < 0) return;
    settings.minCharThreshold = Number(val);
    GM_setValue('minCharThreshold', settings.minCharThreshold);
    removeAllFilters();
    if (settings.enabled) processAllComments();
  });

  GM_registerMenuCommand('Toggle AI filter', () => {
    settings.aiFilterEnabled = !settings.aiFilterEnabled;
    GM_setValue('aiFilterEnabled', settings.aiFilterEnabled);
    alert(`AI filter: ${settings.aiFilterEnabled ? 'ON' : 'OFF'}`);
    removeAllFilters();
    if (settings.enabled) processAllComments();
  });

  GM_registerMenuCommand('Set Gemini API key', () => {
    const key = prompt('Gemini API key:', settings.aiApiKey);
    if (key === null) return;
    settings.aiApiKey = key.trim();
    GM_setValue('aiApiKey', settings.aiApiKey);
  });

  // ── Constants ─────────────────────────────────────────────────────────
  const POST_PATH_RE = /^\/posts\/.+/;
  const COMMENT_SEL = 'div[id^="comment-"]';

  // ── Keyword filter data ───────────────────────────────────────────────
  const EXACT_FLUFF = new Set([
    'nice', 'thanks', 'thank you', 'thx', 'ty',
    '+1', '++', 'bump', 'this', 'same', 'agreed',
    'love this', 'love it', 'awesome', 'amazing',
    'congrats', 'congratulations', 'well done',
    'great', 'great work', 'great job',
    'cool', 'neat', 'sweet', 'wow', 'yep', 'yes',
    'so cool', 'so good', 'incredible', 'brilliant',
    'huge', 'massive', 'legendary', 'fire',
    'lfg', 'lets go', "let's go", 'lgtm',
    'following', 'subscribed', 'interested',
    'me too', 'same here', 'ditto',
    'good luck', 'best of luck', 'rooting for you',
    'welcome', 'welcome aboard',
    'ha', 'haha', 'hahaha', 'lol', 'lmao',
    'woohoo', 'yay', 'woot',
    'bravo', 'kudos', 'props',
    'super', 'solid', 'tight',
    'w', 'w post', 'w take', 'l', 'big w', 'huge w',
    'king', 'queen', 'goat', 'beast', 'legend',
    'inspirational', 'inspiring',
    'needed this', 'needed to hear this',
    'so true', 'facts', 'real talk', 'real',
    'based', 'hard agree',
  ]);

  const FLUFF_PATTERNS = [
    /^congrat(s|ulations)[!.\s]*$/i,
    /^(well done|bravo|kudos|props)[!.\s]*$/i,
    /^congrat(s|ulations)\s+(on\s+)?[\w\s]{1,40}[!.]*$/i,
    /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u,
    /^(amazing|awesome|incredible|fantastic|brilliant|wonderful|beautiful|stunning|insane|wild|sick|dope|fire|lit|goat|beast|legend|king|queen)[!.\s]*$/i,
    /^this is (so )?(amazing|awesome|cool|great|incredible|fantastic|fire|sick|dope|wild|insane|beautiful|wonderful)[!.\s]*$/i,
    /^\+1\s/i,
    /^bump\s/i,
    /^(\w)\1{4,}[!.\s]*$/i,
    /^[wl]\s+\w+[!.\s]*$/i,
    /^holy\s+\w+[!.\s]*$/i,
  ];

  function normalize(text) {
    return text.trim().toLowerCase().replace(/[!?.,:;]+$/, '').trim();
  }

  // ── AI filter ────────────────────────────────────────────────────────
  const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent';
  const AI_MAX_CHAR_LENGTH = 500;
  const MAX_PROMPT_TEXT_LENGTH = 300;
  const MAX_CACHE_ENTRIES = 500;
  const SESSION_CACHE_KEY = 'bf-filter-ai-cache';

  const SYSTEM_PROMPT = `You are a forum comment quality classifier for a startup community. Classify each numbered comment as LOW or HIGH value.

LOW-VALUE: congratulatory fluff, one-word reactions, emoji-only, generic encouragement, memes/jokes with no info, repetitive agreement
HIGH-VALUE: substantive feedback/advice/critique, questions that drive discussion, personal experience/data, counterarguments, specific suggestions, links/resources

Return ONLY a JSON array of objects, one per comment, in order:
[{"id": 1, "low": true, "reason": "brief reason"}, ...]`;

  function loadAiCache() {
    try {
      const raw = localStorage.getItem(SESSION_CACHE_KEY);
      if (!raw) return new Map();
      return new Map(JSON.parse(raw));
    } catch { return new Map(); }
  }

  function saveAiCache(cache) {
    try {
      localStorage.setItem(
        SESSION_CACHE_KEY,
        JSON.stringify(Array.from(cache.entries()).slice(-MAX_CACHE_ENTRIES))
      );
    } catch { /* localStorage full or unavailable */ }
  }

  const aiCache = loadAiCache();

  function aiCacheKey(text) { return text.trim().toLowerCase(); }

  function truncate(text) {
    return text.length > MAX_PROMPT_TEXT_LENGTH
      ? text.slice(0, MAX_PROMPT_TEXT_LENGTH) + '...'
      : text;
  }

  function gmFetch(url, apiKey, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${url}?key=${apiKey}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(JSON.parse(res.responseText));
          } else {
            reject(new Error(`Gemini API ${res.status}: ${res.responseText}`));
          }
        },
        onerror: (err) => reject(err),
      });
    });
  }

  /**
   * Classify a batch of comment texts via Gemini.
   * Returns a Map from original text to { filtered, reason }.
   */
  async function aiClassifyBatch(texts) {
    const results = new Map();
    if (!settings.aiFilterEnabled || !settings.aiApiKey || texts.length === 0) return results;

    // Split into cached and uncached
    const uncachedMap = new Map();
    for (const text of texts) {
      const key = aiCacheKey(text);
      const cached = aiCache.get(key);
      if (cached !== undefined) {
        results.set(text, cached);
      } else if (!uncachedMap.has(key)) {
        uncachedMap.set(key, text);
      }
    }

    const uncachedTexts = Array.from(uncachedMap.values());
    if (uncachedTexts.length === 0) return results;

    const numbered = uncachedTexts.map((t, i) => `${i + 1}. "${truncate(t)}"`).join('\n');

    try {
      const data = await gmFetch(GEMINI_API_URL, settings.aiApiKey, {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: `Comments:\n\n${numbered}` }] }],
      });

      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn('[BF Filter] AI response missing JSON array');
        return results;
      }

      const classifications = JSON.parse(jsonMatch[0]);
      for (const item of classifications) {
        const idx = item.id - 1;
        if (idx < 0 || idx >= uncachedTexts.length) continue;
        const text = uncachedTexts[idx];
        const result = item.low
          ? { filtered: true, reason: `AI: ${item.reason || 'low-value'}` }
          : { filtered: false };
        aiCache.set(aiCacheKey(text), result);
        results.set(text, result);
      }

      // Default unclassified to not-filtered
      for (const text of uncachedTexts) {
        if (!results.has(text)) {
          aiCache.set(aiCacheKey(text), { filtered: false });
          results.set(text, { filtered: false });
        }
      }

      saveAiCache(aiCache);
    } catch (err) {
      console.warn('[BF Filter] AI batch failed:', err);
    }

    return results;
  }

  // ── Filter logic ──────────────────────────────────────────────────────
  function isStaff(commentEl) {
    const badge = commentEl.querySelector('.rounded-xs');
    return badge && badge.textContent.trim().includes('YC');
  }

  function getCommentText(commentEl) {
    const prose = commentEl.querySelector('.prose');
    return prose ? prose.textContent.trim() : '';
  }

  /** Returns a filter reason string, or null if not filtered. */
  function classifyComment(commentEl) {
    if (isStaff(commentEl)) return null;
    const text = getCommentText(commentEl);
    if (!text) return null;

    // Length filter
    if (settings.lengthFilterEnabled && settings.minCharThreshold > 0 && text.length < settings.minCharThreshold) {
      return 'length';
    }

    // Keyword filter
    if (settings.keywordFilterEnabled) {
      const norm = normalize(text);
      if (EXACT_FLUFF.has(norm)) return 'keyword';
      for (const pat of FLUFF_PATTERNS) {
        if (pat.test(text)) return 'keyword-pattern';
      }
    }

    return null;
  }

  // ── Thread context preservation ───────────────────────────────────────
  function hasValuableReplies(commentLi) {
    const childComments = commentLi.querySelectorAll(`:scope > ol ${COMMENT_SEL}`);
    for (const child of childComments) {
      if (isStaff(child)) return true;
      if (!child.hasAttribute('data-bf-filtered')) return true;
    }
    return false;
  }

  function hasValuableAncestor(commentEl) {
    let li = commentEl.closest('li');
    while (li) {
      const parentLi = li.parentElement?.closest('li');
      if (!parentLi) break;
      const parentComment = parentLi.querySelector(`:scope > ${COMMENT_SEL}`);
      if (parentComment && !parentComment.hasAttribute('data-bf-filtered')) return true;
      li = parentLi;
    }
    return false;
  }

  // ── DOM manipulation ──────────────────────────────────────────────────
  function hideComment(commentEl, reason) {
    const li = commentEl.closest('li');
    if (!li) return;
    commentEl.setAttribute('data-bf-filtered', reason);
    li.setAttribute('data-bf-original-display', li.style.display || '');
    li.style.display = 'none';
  }

  function showComment(commentEl) {
    const li = commentEl.closest('li');
    if (!li) return;
    const orig = li.getAttribute('data-bf-original-display');
    li.style.display = orig || '';
    li.removeAttribute('data-bf-original-display');
    commentEl.removeAttribute('data-bf-filtered');
  }

  function removeAllFilters() {
    document.querySelectorAll('[data-bf-filtered]').forEach((el) => {
      showComment(el);
    });
    document.querySelectorAll('.bf-filter-revealed').forEach((el) => {
      el.classList.remove('bf-filter-revealed');
      el.style.opacity = '';
      el.style.borderLeft = '';
    });
    const summary = document.getElementById('bf-filter-summary');
    if (summary) summary.remove();
  }

  // ── Summary bar ───────────────────────────────────────────────────────
  function createOrUpdateSummary(count) {
    const ol = document.querySelector(`ol:has(${COMMENT_SEL})`);
    if (!ol) return;

    let bar = document.getElementById('bf-filter-summary');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bf-filter-summary';
      Object.assign(bar.style, {
        padding: '8px 14px',
        background: '#f5f5f5',
        border: '1px solid #e0e0e0',
        borderRadius: '8px',
        cursor: 'pointer',
        marginBottom: '12px',
        fontSize: '13px',
        color: '#555',
        userSelect: 'none',
      });
      let revealed = false;
      bar.addEventListener('click', () => {
        suppressObserver = true;
        revealed = !revealed;
        document.querySelectorAll('[data-bf-filtered]').forEach((el) => {
          const li = el.closest('li');
          if (!li) return;
          if (revealed) {
            li.style.display = li.getAttribute('data-bf-original-display') || '';
            li.classList.add('bf-filter-revealed');
            li.style.opacity = '0.6';
            li.style.borderLeft = '3px solid #e0e0e0';
          } else {
            li.style.display = 'none';
            li.classList.remove('bf-filter-revealed');
            li.style.opacity = '';
            li.style.borderLeft = '';
          }
        });
        bar.textContent = revealed
          ? `Hide ${count} filtered comments`
          : `Show ${count} filtered comments`;
        requestAnimationFrame(() => { suppressObserver = false; });
      });
      ol.parentNode.insertBefore(bar, ol);
    }
    bar.textContent = `Show ${count} filtered comments`;
  }

  // ── Main processing ───────────────────────────────────────────────────
  function applyFiltersAndHide(filtered) {
    let hiddenCount = 0;
    for (const comment of filtered) {
      const li = comment.closest('li');
      if (li && hasValuableReplies(li)) {
        comment.removeAttribute('data-bf-filtered');
        continue;
      }
      if (hasValuableAncestor(comment)) {
        comment.removeAttribute('data-bf-filtered');
        continue;
      }
      hideComment(comment, comment.getAttribute('data-bf-filtered'));
      hiddenCount++;
    }
    return hiddenCount;
  }

  async function processAllComments() {
    if (!settings.enabled) return;
    if (!POST_PATH_RE.test(location.pathname)) return;

    const comments = document.querySelectorAll(COMMENT_SEL);
    const filtered = [];
    const aiQueue = []; // { element, text }

    // Phase 1: cheap filters (length + keyword)
    for (const comment of comments) {
      const reason = classifyComment(comment);
      if (reason) {
        comment.setAttribute('data-bf-filtered', reason);
        filtered.push(comment);
      } else if (settings.aiFilterEnabled && settings.aiApiKey) {
        const text = getCommentText(comment);
        if (text && text.length <= AI_MAX_CHAR_LENGTH && !isStaff(comment)) {
          aiQueue.push({ element: comment, text });
        }
      }
    }

    // Phase 2: apply cheap filters immediately
    let hiddenCount = applyFiltersAndHide(filtered);
    if (hiddenCount > 0) createOrUpdateSummary(hiddenCount);

    // Phase 3: AI classification (async, batch)
    if (aiQueue.length > 0) {
      const aiResults = await aiClassifyBatch(aiQueue.map((q) => q.text));
      const aiFiltered = [];
      for (const { element, text } of aiQueue) {
        const result = aiResults.get(text);
        if (result && result.filtered) {
          element.setAttribute('data-bf-filtered', result.reason);
          aiFiltered.push(element);
        }
      }
      if (aiFiltered.length > 0) {
        hiddenCount += applyFiltersAndHide(aiFiltered);
        createOrUpdateSummary(hiddenCount);
      }
    }
  }

  // ── Mutation observer for dynamic comments ────────────────────────────
  let suppressObserver = false;
  let rafId = null;
  const observer = new MutationObserver((mutations) => {
    if (suppressObserver) return;
    // Only re-process if actual new comment nodes were added
    const hasNewComments = mutations.some((m) =>
      Array.from(m.addedNodes).some(
        (n) => n.nodeType === 1 && (n.matches?.(COMMENT_SEL) || n.querySelector?.(COMMENT_SEL))
      )
    );
    if (!hasNewComments) return;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      removeAllFilters();
      processAllComments();
    });
  });

  // ── SPA navigation detection ──────────────────────────────────────────
  let lastPath = location.pathname;
  const navObserver = new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      removeAllFilters();
      if (POST_PATH_RE.test(lastPath)) {
        processAllComments();
      }
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    if (POST_PATH_RE.test(location.pathname)) {
      processAllComments();
    }
    observer.observe(document.body, { childList: true, subtree: true });
    navObserver.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
