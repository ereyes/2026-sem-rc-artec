(function () {
  'use strict';
  const data = JSON.parse(document.getElementById('water-data').textContent);
  const score = document.getElementById('score');
  const globalStatus = document.getElementById('global-status');
  const dialog = document.getElementById('inventory-dialog');
  const motionButton = document.getElementById('motion-button');
  const activeLanguages = new Set(data.languages.map((language) => language.code));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const panelMap = new Map();
  let motionPaused = reducedMotion.matches;
  let playingCategory = null;
  let lastInventoryTrigger = null;

  const icons = {
    sound: '<svg class="sound-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 5 5.8 9H3v6h2.8l4.7 4zM15 8.1a5.6 5.6 0 0 1 0 7.8M18.2 5a10 10 0 0 1 0 14"/></svg><svg class="stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>'
  };
  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  data.categories.forEach((category) => {
    category.words.forEach((word, index) => { word.id = `${category.id}-word-${index}`; });
    category.sounds.forEach((sound, index) => { sound.id = `${category.id}-sound-${index}`; });
    const panel = element('section', `movement ${category.id}`);
    panel.id = `movement-${category.id}`;
    panel.setAttribute('aria-labelledby', `title-${category.id}`);
    const head = element('header', 'movement-head');
    const title = element('h2', '', category.title);
    title.id = `title-${category.id}`;
    title.lang = 'fr';
    head.append(title, element('p', 'movement-sources', category.sources));
    const stage = element('div', 'stage');
    stage.setAttribute('aria-hidden', 'true');
    const foot = element('div', 'movement-foot');
    const utterance = element('p', 'utterance', category.description);
    const button = element('button', 'voice-button');
    button.type = 'button';
    button.setAttribute('aria-label', `Listen to ${category.label.toLowerCase()}`);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-keyshortcuts', 'Escape');
    button.title = `Listen to ${category.label.toLowerCase()} · click again to stop`;
    button.innerHTML = icons.sound;
    const listenLabel = element('span', 'listen-label', 'Listen');
    foot.append(utterance, button, listenLabel);
    panel.append(head, stage, foot);
    score.append(panel);
    const tokens = [];
    const initialWords = category.words.slice(0, 5);
    // One word per language and five shared vocal experiments inhabit each panel.
    initialWords.forEach((word, index) => tokens.push(makeToken(word, false, index, category, stage)));
    category.sounds.forEach((sound, index) => tokens.push(makeToken(sound, true, index + 5, category, stage)));
    panelMap.set(category.id, { panel, stage, button, utterance, listenLabel, tokens, category });
    button.addEventListener('click', () => speech.play(category.id, playlist(category)));
  });

  function makeToken(item, isSound, index, category, stage) {
    const token = element('span', `token${isSound ? ' sound' : ''}`);
    token.dataset.itemId = item.id;
    if (!isSound) token.dataset.language = item.lang;
    const body = element('span', 'token-body');
    const text = element('span', 'token-text', item.text);
    if (item.lang) text.lang = item.lang;
    body.append(text, element('span', 'token-lang', isSound ? '∿' : item.lang.toUpperCase()));
    token.append(body);
    const column = index % 5;
    const x = 17 + column * 16;
    const y = 11 + ((index * 29) % 72);
    token.style.setProperty('--x', `${category.id === 'bubbling' ? (isSound ? 69 : 29) : x}%`);
    token.style.setProperty('--y', `${category.id === 'bubbling' ? 9 + column * 17 + (isSound ? 7 : 0) : y}%`);
    const duration = { falling: 24, flowing: 28, bubbling: 42, mouth: 30 }[category.id];
    token.style.setProperty('--duration', `${duration}s`);
    token.style.setProperty('--delay', `${-(index * duration / 10 + 2.8)}s`);
    token.style.setProperty('--drift', `${(column - 2) * 10}px`);
    token.style.setProperty('--size', `${isSound ? 30 + (index % 3) * 3 : 22 + (index % 3) * 2}px`);
    token.dataset.column = String(column);
    token.dataset.index = String(index);
    body.addEventListener('animationiteration', () => {
      if (isSound || playingCategory === category.id) return;
      const choices = category.words.filter((word) => word.lang === item.lang);
      const currentIndex = choices.findIndex((word) => word.id === token.dataset.itemId);
      updateToken(token, choices[(currentIndex + 1) % choices.length]);
    });
    stage.append(token);
    return token;
  }

  function updateToken(token, item) {
    token.dataset.itemId = item.id;
    const text = token.querySelector('.token-text');
    text.textContent = item.text;
    if (item.lang) text.lang = item.lang;
  }

  function resizeStages() {
    panelMap.forEach(({ stage, tokens }) => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      stage.style.setProperty('--travel-y', `${height + 90}px`);
      stage.style.setProperty('--travel-x', `${width + 140}px`);
      tokens.forEach((token) => {
        const i = Number(token.dataset.index);
        const col = Number(token.dataset.column);
        token.style.setProperty('--radius-x', `${Math.min(13, width * .035)}px`);
        token.style.setProperty('--radius-y', `${Math.min(17, height * .045)}px`);
        token.style.setProperty('--pull-x', `${(2 - col) * width * .16}px`);
        token.style.setProperty('--pull-y', `${height * (.67 - (11 + ((i * 29) % 72)) / 100)}px`);
      });
    });
  }
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(resizeStages);
    panelMap.forEach(({ stage }) => observer.observe(stage));
  } else window.addEventListener('resize', resizeStages);
  resizeStages();

  function playlist(category) {
    const selected = data.languages.filter((language) => activeLanguages.has(language.code));
    const words = category.words.filter((word) => activeLanguages.has(word.lang));
    const items = [];
    for (let index = 0; index < Math.max(words.length, category.sounds.length); index += 1) {
      if (words[index]) items.push({ ...words[index], rate: .83 });
      if (category.sounds[index]) items.push({
        ...category.sounds[index], lang: selected[index % selected.length].code,
        rate: .76, pitch: category.id === 'bubbling' ? .85 : 1
      });
    }
    return items;
  }

  function clearSpeaking() {
    score.querySelectorAll('.is-speaking').forEach((token) => token.classList.remove('is-speaking'));
  }
  const speech = new window.WaterSpeech({
    onState({ categoryId, playing }) {
      playingCategory = playing ? categoryId : null;
      panelMap.forEach((view, id) => {
        const active = playing && id === categoryId;
        view.panel.classList.toggle('is-playing', active);
        view.button.setAttribute('aria-pressed', String(active));
        view.button.setAttribute('aria-label', `${active ? 'Stop' : 'Listen to'} ${view.category.label.toLowerCase()}`);
        view.listenLabel.textContent = active ? 'Stop' : 'Listen';
        if (!active) view.utterance.textContent = view.category.description;
      });
      if (!playing) clearSpeaking();
    },
    onWord(event) {
      clearSpeaking();
      if (!event) return;
      const { categoryId, item, index, total } = event;
      const view = panelMap.get(categoryId);
      let token = view.tokens.find((candidate) => candidate.dataset.itemId === item.id);
      if (!token) {
        token = view.tokens.find((candidate) => candidate.dataset.language === item.lang);
        if (token) updateToken(token, item);
      }
      if (token) token.classList.add('is-speaking');
      view.utterance.replaceChildren(element('span', 'utterance-lang', item.lang.toUpperCase()), document.createTextNode(`${item.text} · ${index + 1}/${total}`));
    },
    onStatus(message) { globalStatus.textContent = message; }
  });
  if (!speech.supported) panelMap.forEach(({ button, listenLabel }) => {
    button.disabled = true;
    listenLabel.textContent = 'Voice unavailable';
  });

  data.languages.forEach((language) => {
    const button = element('button', '', language.label);
    button.type = 'button';
    button.lang = language.code;
    button.title = `${language.name} · show and pronounce`;
    button.setAttribute('aria-label', language.name);
    button.setAttribute('aria-pressed', 'true');
    button.addEventListener('click', () => {
      if (activeLanguages.has(language.code)) {
        if (activeLanguages.size === 1) {
          globalStatus.textContent = 'Keep at least one language selected.';
          return;
        }
        activeLanguages.delete(language.code);
      } else activeLanguages.add(language.code);
      speech.stop();
      button.setAttribute('aria-pressed', String(activeLanguages.has(language.code)));
      panelMap.forEach(({ tokens }) => tokens.forEach((token) => {
        if (token.dataset.language) token.hidden = !activeLanguages.has(token.dataset.language);
      }));
      if (speech.supported) globalStatus.textContent = `Languages: ${data.languages.filter((item) => activeLanguages.has(item.code)).map((item) => item.label).join(' · ')}. Choose a circle to listen.`;
    });
    document.querySelector('.languages').append(button);
  });

  function setMotion(paused) {
    motionPaused = paused;
    document.body.classList.toggle('motion-paused', paused);
    motionButton.setAttribute('aria-pressed', String(paused));
    motionButton.setAttribute('aria-label', `${paused ? 'Resume' : 'Pause'} animation`);
    motionButton.title = `${paused ? 'Resume' : 'Pause'} animation`;
    motionButton.innerHTML = paused ? icons.play : icons.pause;
  }
  motionButton.addEventListener('click', () => setMotion(!motionPaused));
  reducedMotion.addEventListener('change', (event) => setMotion(event.matches));
  setMotion(motionPaused);

  function renderInventory() {
    const content = document.getElementById('inventory-content');
    data.categories.forEach((category) => {
      const section = element('section', 'inventory-category');
      section.id = `inventory-${category.id}`;
      const heading = element('h3');
      heading.textContent = `${category.title} / ${category.label}`;
      section.append(heading, element('p', '', category.description));
      const bank = element('div', 'word-bank');
      data.languages.forEach((language) => {
        const group = element('div', 'language-bank');
        group.lang = language.code;
        group.append(element('b', '', language.label));
        category.words.filter((word) => word.lang === language.code).forEach((word, index) => {
          if (index) group.append(document.createElement('br'));
          group.append(document.createTextNode(word.text));
        });
        bank.append(group);
      });
      const sounds = element('div', 'sound-bank');
      sounds.append(element('strong', '', 'VOCAL EXPERIMENTS'), document.createTextNode(category.sounds.map((sound) => sound.text).join(' · ')));
      const table = element('table');
      const thead = element('thead');
      const headingRow = element('tr');
      ['Water event / action', 'Sound spellings', 'Sources / objects / instruments'].forEach((label) => {
        const cell = element('th', '', label);
        cell.scope = 'col';
        headingRow.append(cell);
      });
      thead.append(headingRow);
      const tbody = element('tbody');
      const events = [...category.events, ...data.additionalEvents.filter((event) => event.categories.includes(category.id))];
      events.forEach((event) => {
        const row = element('tr');
        row.append(element('td', '', event.event), element('td', '', event.sound), element('td', '', event.source));
        tbody.append(row);
      });
      table.append(thead, tbody);
      const wrapper = element('div', 'table-wrap');
      wrapper.tabIndex = 0;
      wrapper.setAttribute('aria-label', `${category.label} sound inventory, scroll horizontally on a small screen`);
      wrapper.append(table);
      section.append(bank, sounds, wrapper);
      content.append(section);
    });
  }
  function updateVoiceSummary() {
    const summary = document.getElementById('voice-summary');
    summary.className = 'voice-summary';
    summary.replaceChildren();
    speech.getVoiceSummary().forEach((voice) => {
      const text = `${voice.lang.toUpperCase()} · ${voice.available ? voice.voiceName : 'no matching voice listed'}`;
      summary.append(element('span', `voice-chip${voice.available ? '' : ' unavailable'}`, text));
    });
  }
  renderInventory();
  updateVoiceSummary();
  if (speech.supported) window.speechSynthesis.addEventListener('voiceschanged', updateVoiceSummary);
  document.getElementById('inventory-button').addEventListener('click', (event) => {
    lastInventoryTrigger = event.currentTarget;
    updateVoiceSummary();
    dialog.showModal();
  });
  document.getElementById('close-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (lastInventoryTrigger) lastInventoryTrigger.focus(); });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  } });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') speech.stop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) speech.stop(); });
  window.addEventListener('pagehide', () => speech.stop());
}());
