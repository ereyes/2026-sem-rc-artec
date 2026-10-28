/* Local voice-take editor. No microphone permission or playback is requested
 * until the corresponding Record or Preview control is used.
 * Public API: open(categoryId?, trigger?), close(), getTakes().
 * getTakes()/onChange contain custom overrides; the ready count also includes
 * embedded kind:'vocal' defaults. All audio stays in this browser.
 */
(function () {
  'use strict';

  const MAX_BYTES = 10 * 1024 * 1024;
  const OUTPUT_RATE = 22050;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const slotKey = (categoryId, soundIndex) => `${categoryId}:${soundIndex}`;

  class VoiceStudio {
    constructor({ audio, bank = {}, categories = [], dialog, pristineHTML = '', onChange = () => {} }) {
      this._audio = audio;
      this._bank = bank;
      this._categories = categories;
      this._dialog = dialog;
      this._body = dialog.querySelector('#voice-studio-body');
      if (!this._body) throw new Error('Voice studio body is missing.');
      this._pristineHTML = pristineHTML;
      this._onChange = onChange;
      this._takes = new Map();
      this._defaults = new Map((bank.clips || []).filter((clip) => clip.kind === 'vocal')
        .map((clip) => [slotKey(clip.categoryId, clip.soundIndex), clip]));
      this._slotVersions = new Map();
      this._categoryId = categories[0] ? categories[0].id : '';
      this._soundIndex = 0;
      this._isOpen = false;
      this._trigger = null;
      this._busy = null;
      this._candidate = null;
      this._previewURL = null;
      this._capture = null;
      this._captureToken = 0;
      this._workToken = 0;
      this._decoder = null;
      this._restoring = true;
      this._storageFailed = false;
      this._storageQueue = Promise.resolve();
      this._canDecode = Boolean(window.AudioContext || window.webkitAudioContext);
      this._canRecord = this._canDecode && Boolean(window.MediaRecorder &&
        window.navigator.mediaDevices && window.navigator.mediaDevices.getUserMedia);
      this._build();
      const close = dialog.querySelector('#voice-close');
      if (close) close.addEventListener('click', () => this.close());
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
      dialog.addEventListener('close', () => { if (this._isOpen) this._finishClose(); });
      window.addEventListener('pagehide', () => {
        this._cancelDraftWork();
        this._audio.stopAll();
        if (this._decoder && this._decoder.state !== 'closed') this._decoder.close().catch(() => {});
        this._decoder = null;
      });
      this._dbReady = this._openDB();
      this._restore();
    }

    _build() {
      const wrapper = element('div', 'voice-studio');
      wrapper.append(element('p', 'studio-intro', 'Preview the included voice takes, or record/import a replacement. Accepted takes join the independent voice layers.'));
      this._count = element('p', 'studio-count');
      wrapper.append(this._count);
      const selectors = element('div', 'studio-selectors');
      const categoryField = element('label', 'studio-field');
      categoryField.append(element('span', '', 'Water movement'));
      this._categorySelect = element('select');
      this._categorySelect.id = 'studio-category';
      this._categories.forEach((category) => {
        const option = element('option', '', `${category.title} · ${category.label}`);
        option.value = category.id;
        this._categorySelect.append(option);
      });
      categoryField.append(this._categorySelect);
      const soundField = element('label', 'studio-field');
      soundField.append(element('span', '', 'Sound to say'));
      this._soundSelect = element('select');
      this._soundSelect.id = 'studio-sound';
      soundField.append(this._soundSelect);
      selectors.append(categoryField, soundField);
      wrapper.append(selectors);
      const prompt = element('div', 'studio-prompt');
      this._promptWord = element('p', 'studio-prompt-word');
      this._promptWord.id = 'studio-prompt';
      this._promptNote = element('p', 'studio-prompt-note');
      this._slotStatus = element('p', 'studio-slot-status');
      prompt.append(this._promptWord, this._promptNote, this._slotStatus);
      wrapper.append(prompt);
      const actions = element('div', 'studio-actions');
      const button = (id, modifier, label, action) => {
        const node = element('button', `studio-button ${modifier}`, label);
        node.type = 'button';
        node.id = id;
        node.addEventListener('click', action);
        actions.append(node);
        return node;
      };
      this._recordButton = button('studio-record', 'studio-record', 'Record', () => this._record());
      this._stopButton = button('studio-stop', 'studio-stop', 'Stop', () => this._stopRecording());
      this._previewButton = button('studio-preview', 'studio-preview', 'Preview', () => this._playPreview());
      this._useButton = button('studio-use', 'studio-use', 'Use take', () => this._useCandidate());
      this._importButton = button('studio-import', 'studio-import', 'Import audio', () => this._file.click());
      this._resetButton = button('studio-reset', 'studio-reset', 'Reset', () => this._resetSelected());
      wrapper.append(actions);
      this._file = element('input');
      this._file.type = 'file';
      this._file.accept = 'audio/*,.wav,.mp3,.m4a,.ogg,.webm';
      this._file.id = 'studio-file';
      this._file.hidden = true;
      this._file.addEventListener('change', () => {
        const file = this._file.files && this._file.files[0];
        this._file.value = '';
        if (!file || this._busy) return;
        this._audio.stopAll();
        this._discardCandidate();
        this._processBlob(file, this._selectedSlot(), ++this._workToken);
      });
      wrapper.append(this._file);
      this._preview = element('audio', 'studio-audio');
      this._preview.id = 'studio-audio';
      this._preview.controls = true;
      this._preview.preload = 'metadata';
      this._preview.hidden = true;
      this._preview.addEventListener('play', () => this._audio.stopAll());
      wrapper.append(this._preview);
      this._message = element('p', 'studio-message');
      this._message.id = 'studio-message';
      this._message.setAttribute('role', 'status');
      this._message.setAttribute('aria-live', 'polite');
      this._storage = element('p', 'studio-storage');
      wrapper.append(this._message, this._storage);
      const footer = element('div', 'studio-footer');
      this._downloadButton = element('button', 'studio-button studio-download', 'Download HTML with voices');
      this._downloadButton.id = 'studio-download';
      this._downloadButton.type = 'button';
      this._downloadButton.addEventListener('click', () => this._downloadHTML());
      footer.append(this._downloadButton, element('p', 'studio-privacy', 'Microphone access begins only when you press Record. Nothing is uploaded. Imports: up to 10 MB and 20 seconds; recordings stop after 10 seconds.'));
      wrapper.append(footer);
      this._body.replaceChildren(wrapper);
      this._categorySelect.addEventListener('change', () => {
        this._cancelDraftWork();
        this._categoryId = this._categorySelect.value;
        this._soundIndex = 0;
        this._renderSelection();
        this._setMessage('Choose a sound, then record or import yourself saying it.');
      });
      this._soundSelect.addEventListener('change', () => {
        this._cancelDraftWork();
        this._soundIndex = Number(this._soundSelect.value);
        this._renderSelection();
        this._setMessage('Record a new take or preview the current voice.');
      });
      this._renderSelection();
      this._renderStorage();
    }

    _category() { return this._categories.find((category) => category.id === this._categoryId); }
    _sound() { const category = this._category(); return category && category.sounds[this._soundIndex]; }
    _selectedSlot() { return { categoryId: this._categoryId, soundIndex: this._soundIndex }; }
    _selectedKey() { return slotKey(this._categoryId, this._soundIndex); }
    _currentTake() { return this._takes.get(this._selectedKey()) || this._defaults.get(this._selectedKey()) || null; }
    _hasTake(categoryId, index) { const key = slotKey(categoryId, index); return this._takes.has(key) || this._defaults.has(key); }

    _renderSelection() {
      this._categorySelect.value = this._categoryId;
      const category = this._category();
      this._soundSelect.replaceChildren();
      (category ? category.sounds : []).forEach((sound, index) => {
        const option = element('option', '', `${sound.text}${this._hasTake(this._categoryId, index) ? ' · ready' : ' · needs a take'}`);
        option.value = String(index);
        this._soundSelect.append(option);
      });
      this._soundSelect.value = String(this._soundIndex);
      const sound = this._sound();
      this._promptWord.textContent = sound ? sound.text : 'Choose a sound';
      this._promptNote.textContent = sound ? (sound.prompt || `Say “${sound.text}” aloud. Keep a little space before and after the sound.`) : '';
      const take = this._currentTake();
      this._slotStatus.textContent = take
        ? `${this._takes.has(this._selectedKey()) ? 'Your accepted voice take' : take.provenance==='generated' ? 'AI-generated voice take' : 'Recorded spoken take'}${Number.isFinite(take.duration) ? ` · ${take.duration.toFixed(1)} s` : ''}`
        : 'No voiced take yet. Record or import yourself saying this sound.';
      let total = 0;
      let ready = 0;
      this._categories.forEach((item) => item.sounds.forEach((unused, index) => { total += 1; if (this._hasTake(item.id, index)) ready += 1; }));
      this._count.textContent = `${ready}/${total} voiced sounds ready`;
      if (this._isOpen && !this._candidate && !this._busy) this._showPreview(take);
      this._updateControls();
    }

    _updateControls() {
      const busy = Boolean(this._busy);
      this._categorySelect.disabled = busy;
      this._soundSelect.disabled = busy;
      this._recordButton.disabled = busy || !this._canRecord || !this._sound();
      this._stopButton.disabled = !['permission', 'recording'].includes(this._busy);
      this._stopButton.textContent = this._busy === 'permission' ? 'Cancel request' : 'Stop';
      this._previewButton.disabled = busy || !this._previewURL;
      this._useButton.disabled = busy || !this._candidate;
      this._importButton.disabled = busy || !this._canDecode || !this._sound();
      this._resetButton.disabled = busy || !this._takes.has(this._selectedKey());
      this._downloadButton.disabled = busy || this._restoring || !this._pristineHTML;
      this._recordButton.setAttribute('aria-pressed', String(this._busy === 'recording'));
      this._body.classList.toggle('studio-is-recording', this._busy === 'recording');
    }

    _setMessage(message, state = 'info') {
      this._message.textContent = message;
      this._message.dataset.state = state;
    }

    _renderStorage() {
      this._storage.textContent = this._storageFailed
        ? 'Local saving is unavailable. Takes still work for this session; download the HTML to keep them.'
        : this._restoring ? 'Restoring voice takes saved in this browser…'
          : 'Accepted takes are saved in this browser. Download the HTML to carry the voices with you.';
      this._storage.dataset.state = this._storageFailed ? 'error' : 'ok';
    }

    open(categoryId, trigger) {
      this._cancelDraftWork();
      if (categoryId && this._categories.some((category) => category.id === categoryId)) {
        this._categoryId = categoryId;
        const sounds = this._category().sounds;
        const missing = sounds.findIndex((unused, index) => !this._hasTake(categoryId, index));
        this._soundIndex = missing < 0 ? 0 : missing;
      }
      this._trigger = trigger || document.activeElement;
      this._isOpen = true;
      this._renderSelection();
      this._setMessage(this._currentTake()
        ? 'This take is ready to play. Preview it here; recording or importing a replacement is optional.'
        : this._canRecord
          ? 'Say the written sound with your voice. Preview it, then choose Use take.'
          : 'Microphone recording is unavailable here. Import an audio file of someone saying the written sound.');
      if (!this._dialog.open) this._dialog.showModal();
      this._categorySelect.focus();
    }

    close() {
      this._finishClose();
      if (this._dialog.open) this._dialog.close();
    }

    _finishClose() {
      this._isOpen = false;
      this._cancelDraftWork();
      const trigger = this._trigger;
      this._trigger = null;
      if (trigger && trigger.isConnected && typeof trigger.focus === 'function') trigger.focus();
    }

    _cancelDraftWork() {
      this._workToken += 1;
      this._captureToken += 1;
      const capture = this._capture;
      this._capture = null;
      if (capture) {
        capture.discard = true;
        this._clearCaptureTimers(capture);
        if (capture.recorder && capture.recorder.state !== 'inactive') {
          try { capture.recorder.stop(); } catch (error) {}
        }
        this._stopTracks(capture.stream);
      }
      if (this._busy !== 'applying') this._busy = null;
      this._discardCandidate();
      this._updateControls();
    }

    _stopTracks(stream) {
      if (stream && typeof stream.getTracks === 'function') stream.getTracks().forEach((track) => { try { track.stop(); } catch (error) {} });
    }

    _clearCaptureTimers(capture) {
      window.clearTimeout(capture.limitTimer);
      window.clearInterval(capture.clockTimer);
    }

    async _record() {
      if (this._busy || !this._canRecord || !this._isOpen) return;
      this._audio.stopAll();
      this._discardCandidate();
      const token = ++this._captureToken;
      const workToken = ++this._workToken;
      const slot = this._selectedSlot();
      this._busy = 'permission';
      this._setMessage('Waiting for microphone permission. You can cancel this request.');
      this._updateControls();
      let stream;
      try {
        stream = await window.navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false
        });
        if (token !== this._captureToken || !this._isOpen) { this._stopTracks(stream); return; }
        const Recorder = window.MediaRecorder;
        const types = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
        const mimeType = typeof Recorder.isTypeSupported === 'function' ? types.find((type) => Recorder.isTypeSupported(type)) : null;
        const recorder = mimeType ? new Recorder(stream, { mimeType }) : new Recorder(stream);
        const capture = { token, workToken, slot, stream, recorder, chunks: [], bytes: 0, discard: false, stopping: false, started: Date.now() };
        this._capture = capture;
        recorder.ondataavailable = (event) => {
          if (capture.discard || !event.data || !event.data.size) return;
          capture.bytes += event.data.size;
          if (capture.bytes > MAX_BYTES) { this._captureError(capture, 'The recording is too large. Try a shorter spoken take.'); return; }
          capture.chunks.push(event.data);
        };
        recorder.onerror = () => this._captureError(capture, 'The microphone could not record this take. You can import a spoken audio file instead.');
        recorder.onstop = () => {
          this._clearCaptureTimers(capture);
          this._stopTracks(stream);
          if (this._capture === capture) this._capture = null;
          if (capture.discard || token !== this._captureToken || workToken !== this._workToken || !this._isOpen) return;
          const blob = new Blob(capture.chunks, { type: recorder.mimeType || (capture.chunks[0] && capture.chunks[0].type) || 'audio/webm' });
          this._processBlob(blob, slot, workToken);
        };
        recorder.start(250);
        this._busy = 'recording';
        this._setMessage('Recording… 0 / 10 s. Say the written sound aloud.');
        capture.clockTimer = window.setInterval(() => {
          if (capture !== this._capture || capture.stopping) return;
          const seconds = Math.min(10, Math.floor((Date.now() - capture.started) / 1000));
          this._setMessage(`Recording… ${seconds} / 10 s. Say the written sound aloud.`);
        }, 500);
        capture.limitTimer = window.setTimeout(() => this._stopRecording(), 10000);
        this._updateControls();
      } catch (error) {
        this._stopTracks(stream);
        if (token !== this._captureToken || !this._isOpen) return;
        this._capture = null;
        this._busy = null;
        this._showPreview(this._currentTake());
        this._setMessage(error && error.name === 'NotAllowedError'
          ? 'Microphone access was not granted. You can import a spoken take instead.'
          : 'No microphone recording could be started. You can import a spoken take instead.', 'error');
        this._updateControls();
      }
    }

    _captureError(capture, message) {
      if (capture !== this._capture) return;
      capture.discard = true;
      this._clearCaptureTimers(capture);
      this._stopTracks(capture.stream);
      if (capture.recorder.state !== 'inactive') { try { capture.recorder.stop(); } catch (error) {} }
      this._capture = null;
      this._busy = null;
      if (this._isOpen) this._showPreview(this._currentTake());
      this._setMessage(message, 'error');
      this._updateControls();
    }

    _stopRecording() {
      if (this._busy === 'permission') {
        this._captureToken += 1;
        this._workToken += 1;
        this._busy = null;
        this._showPreview(this._currentTake());
        this._setMessage('Microphone request canceled. No returned microphone stream will be kept.');
        this._updateControls();
        return;
      }
      const capture = this._capture;
      if (!capture || capture.stopping) return;
      capture.stopping = true;
      this._clearCaptureTimers(capture);
      this._busy = 'processing';
      this._setMessage('Preparing your spoken take…');
      this._updateControls();
      try { capture.recorder.stop(); }
      catch (error) { this._captureError(capture, 'This take could not be finished. Please record it again.'); }
      this._stopTracks(capture.stream);
    }

    _getDecoder() {
      if (!this._decoder || this._decoder.state === 'closed') {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error('Audio processing is unavailable in this browser.');
        this._decoder = new Context();
      }
      return this._decoder;
    }

    async _processBlob(blob, slot, token) {
      this._busy = 'processing';
      this._setMessage('Preparing your spoken take…');
      this._updateControls();
      try {
        if (!blob.size || blob.size > MAX_BYTES) throw new Error('Choose an audio file up to 10 MB.');
        const bytes = await blob.arrayBuffer();
        if (token !== this._workToken || !this._isOpen) return;
        let buffer;
        try { buffer = await this._getDecoder().decodeAudioData(bytes); }
        catch (error) { throw new Error('That audio could not be read. Try a WAV, MP3, M4A, or WebM audio file.'); }
        if (token !== this._workToken || !this._isOpen) return;
        const encoded = VoiceStudio.encodeWav(buffer);
        const wavBlob = new Blob([encoded.bytes], { type: 'audio/wav' });
        const binary = new Uint8Array(encoded.bytes);
        let raw = '';
        for (let offset = 0; offset < binary.length; offset += 32768) {
          raw += String.fromCharCode(...binary.subarray(offset, offset + 32768));
        }
        this._candidate = { slot, data: window.btoa(raw), mime: 'audio/wav', duration: encoded.duration, blob: wavBlob };
        this._showPreview(this._candidate);
        this._setMessage(`New take · ${encoded.duration.toFixed(1)} s. Preview it, then choose Use take. Your current voice is kept until then.`, 'ok');
      } catch (error) {
        if (token !== this._workToken || !this._isOpen) return;
        this._setMessage(error.message || 'The take could not be prepared. Your current voice has been kept.', 'error');
        this._showPreview(this._currentTake());
      } finally {
        if (token === this._workToken) { this._busy = null; this._updateControls(); }
      }
    }

    static encodeWav(buffer) {
      if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration < 0.05 || buffer.duration > 20) {
        throw new Error('Use a spoken take lasting 0.05 to 20 seconds.');
      }
      if (!Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 || !buffer.length || !buffer.numberOfChannels) {
        throw new Error('This audio recording has no readable samples.');
      }
      const frames = Math.max(1, Math.round(buffer.length * OUTPUT_RATE / buffer.sampleRate));
      const channels = Array.from({ length: buffer.numberOfChannels }, (unused, index) => buffer.getChannelData(index));
      const samples = new Float32Array(frames);
      let mean = 0;
      for (let index = 0; index < frames; index += 1) {
        const position = Math.min(buffer.length - 1, index * buffer.sampleRate / OUTPUT_RATE);
        const left = Math.floor(position);
        const right = Math.min(buffer.length - 1, left + 1);
        const fraction = position - left;
        let value = 0;
        channels.forEach((channel) => { value += channel[left] * (1 - fraction) + channel[right] * fraction; });
        samples[index] = value / channels.length;
        mean += samples[index];
      }
      mean /= frames;
      let peak = 0;
      for (let index = 0; index < frames; index += 1) {
        samples[index] -= mean;
        peak = Math.max(peak, Math.abs(samples[index]));
      }
      const gain = peak > 1e-8 ? Math.min(4, 0.72 / peak) : 1;
      const fade = Math.min(Math.round(0.005 * OUTPUT_RATE), Math.floor((frames - 1) / 2));
      const bytes = new ArrayBuffer(44 + frames * 2);
      const view = new DataView(bytes);
      const word = (offset, text) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)); };
      word(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); word(8, 'WAVE');
      word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, 1, true); view.setUint32(24, OUTPUT_RATE, true);
      view.setUint32(28, OUTPUT_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      word(36, 'data'); view.setUint32(40, frames * 2, true);
      for (let index = 0; index < frames; index += 1) {
        const edge = fade ? Math.min(1, index / fade, (frames - 1 - index) / fade) : 1;
        const value = Math.max(-1, Math.min(1, samples[index] * gain * edge));
        view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      return { bytes, duration: frames / OUTPUT_RATE, sampleRate: OUTPUT_RATE };
    }

    _clearPreview() {
      this._preview.pause();
      this._preview.removeAttribute('src');
      this._preview.hidden = true;
      if (this._previewURL) window.URL.revokeObjectURL(this._previewURL);
      this._previewURL = null;
    }

    _showPreview(take) {
      this._clearPreview();
      if (!take || !this._isOpen) return;
      try {
        let blob = take.blob;
        if (!blob) {
          const raw = window.atob(String(take.data || '').replace(/^data:[^,]*,/, ''));
          const bytes = new Uint8Array(raw.length);
          for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
          blob = new Blob([bytes], { type: take.mime || 'audio/wav' });
        }
        this._previewURL = window.URL.createObjectURL(blob);
        this._preview.src = this._previewURL;
        this._preview.hidden = false;
      } catch (error) { this._setMessage('This preview could not be opened. Record or import a new spoken take.', 'error'); }
      this._updateControls();
    }

    _discardCandidate() { this._candidate = null; this._clearPreview(); }

    _playPreview() {
      if (this._busy || !this._previewURL) return;
      this._audio.stopAll();
      const result = this._preview.play();
      if (result && typeof result.catch === 'function') result.catch(() => this._setMessage('Preview could not start. Try the audio player’s play button.', 'error'));
    }

    async _useCandidate() {
      if (this._busy || !this._candidate) return;
      const candidate = this._candidate;
      const { categoryId, soundIndex } = candidate.slot;
      const category = this._categories.find((item) => item.id === categoryId);
      const sound = category.sounds[soundIndex];
      const slot = slotKey(categoryId, soundIndex);
      const version = (this._slotVersions.get(slot) || 0) + 1;
      this._slotVersions.set(slot, version);
      this._busy = 'applying';
      this._preview.pause();
      this._setMessage('Checking and accepting this spoken take…');
      this._updateControls();
      try {
        const id = `user-vocal-${categoryId}-${soundIndex}`;
        const take = await this._audio.setVocalTake({
          id, categoryId, soundIndex, kind: 'vocal', data: candidate.data,
          mime: 'audio/wav', duration: candidate.duration, label: sound.text,
          text: sound.text, sourceId: id
        });
        if (!take || this._slotVersions.get(slot) !== version) return;
        this._takes.set(slot, take);
        if (this._candidate === candidate) this._candidate = null;
        this._persist(slot, take);
        this._notify();
        this._renderSelection();
        if (this._isOpen) this._setMessage('Voice take accepted. It will join this layer the next time the sound is chosen.', 'ok');
      } catch (error) {
        if (this._isOpen) this._setMessage('This take could not be accepted. Your previous voice has been kept; record or import another take.', 'error');
      } finally {
        this._busy = null;
        this._updateControls();
      }
    }

    _resetSelected() {
      if (this._busy) return;
      const slot = this._selectedKey();
      this._slotVersions.set(slot, (this._slotVersions.get(slot) || 0) + 1);
      this._cancelDraftWork();
      this._audio.removeVocalTake(this._categoryId, this._soundIndex);
      this._takes.delete(slot);
      this._persist(slot, null);
      this._notify();
      this._renderSelection();
      this._setMessage(this._defaults.has(slot) ? 'Custom take removed. The included spoken take is restored.' : 'Custom take removed. Record or import a new spoken take for this sound.', 'ok');
    }

    getTakes() { return [...this._takes.values()].map((take) => ({ ...take })); }
    _notify() { this._onChange(this.getTakes()); }

    _openDB() {
      return new Promise((resolve) => {
        let finished = false;
        const done = (db) => {
          if (finished) { if (db) db.close(); return; }
          finished = true;
          window.clearTimeout(timeout);
          if (!db) this._storageFailed = true;
          resolve(db);
        };
        const timeout = window.setTimeout(() => done(null), 2500);
        try {
          if (!window.indexedDB) { done(null); return; }
          const request = window.indexedDB.open('water-voices-studio-v1', 1);
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('takes')) request.result.createObjectStore('takes', { keyPath: 'slot' });
          };
          request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); this._storageFailed = true; this._renderStorage(); };
            done(db);
          };
          request.onerror = () => done(null);
          request.onblocked = () => done(null);
        } catch (error) { done(null); }
      });
    }

    async _restore() {
      let failures = 0;
      try {
        const db = await this._dbReady;
        if (!db) return;
        const records = await new Promise((resolve, reject) => {
          const request = db.transaction('takes', 'readonly').objectStore('takes').getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(new Error('storage-read'));
        });
        for (const record of records) {
          const take = record && record.take;
          const category = take && this._categories.find((item) => item.id === take.categoryId);
          if (!category || !Number.isInteger(take.soundIndex) || !category.sounds[take.soundIndex]) { failures += 1; continue; }
          const slot = slotKey(take.categoryId, take.soundIndex);
          if ((this._slotVersions.get(slot) || 0) !== 0) continue;
          try {
            const accepted = await this._audio.setVocalTake(take);
            if (accepted && (this._slotVersions.get(slot) || 0) === 0) {
              this._takes.set(slot, accepted);
              this._notify();
            }
          } catch (error) { failures += 1; }
        }
      } catch (error) { this._storageFailed = true; }
      finally {
        this._restoring = false;
        this._renderStorage();
        this._renderSelection();
        this._notify();
        if (failures && this._isOpen) this._setMessage('Some saved takes could not be restored. The included voices remain available.', 'error');
      }
    }

    _persist(slot, take) {
      this._storageQueue = this._storageQueue.then(async () => {
        const db = await this._dbReady;
        if (!db) throw new Error('storage-unavailable');
        await new Promise((resolve, reject) => {
          const transaction = db.transaction('takes', 'readwrite');
          const store = transaction.objectStore('takes');
          if (take) store.put({ slot, take }); else store.delete(slot);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(new Error('storage-write'));
          transaction.onabort = () => reject(new Error('storage-write'));
        });
      }).catch(() => { this._storageFailed = true; }).finally(() => this._renderStorage());
    }

    _downloadHTML() {
      if (this._busy || this._restoring || !this._pristineHTML) return;
      try {
        const doc = new window.DOMParser().parseFromString(this._pristineHTML, 'text/html');
        const target = doc.getElementById('audio-data');
        if (!target) throw new Error('missing-bank');
        const custom = this.getTakes().map((take) => ({ ...take, kind: 'vocal', sourceId: take.id }));
        const replaced = new Set(custom.map((take) => slotKey(take.categoryId, take.soundIndex)));
        const clips = (this._bank.clips || []).filter((clip) =>
          clip.kind === 'word' || (clip.kind === 'vocal' && !replaced.has(slotKey(clip.categoryId, clip.soundIndex)))
        ).concat(custom);
        const sourceMap = new Map((this._bank.sources || []).map((source) => [source.id, source]));
        custom.forEach((take) => sourceMap.set(take.sourceId, {
          id: take.sourceId, title: `Your voice take · ${take.label || take.text || 'spoken sound'}`,
          author: 'User-supplied voice', license: 'User recording', url: null
        }));
        const used = new Set(clips.map((clip) => clip.sourceId));
        const bank = { ...this._bank, clips, sources: [...sourceMap.values()].filter((source) => used.has(source.id)) };
        target.textContent = JSON.stringify(bank).replace(/</g, '\\u003c');
        const html = '<!doctype html>\n' + doc.documentElement.outerHTML;
        const url = window.URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        const link = element('a');
        link.href = url;
        link.download = 'water-voices-vocal.html';
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 30000);
        this._setMessage('HTML downloaded with the included voices and your accepted takes embedded.', 'ok');
      } catch (error) { this._setMessage('The HTML could not be downloaded. Your accepted takes remain available in this session.', 'error'); }
    }
  }

  window.VoiceStudio = VoiceStudio;
}());
