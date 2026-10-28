/* Independent, repeating layers of recorded words and voiced onomatopoeias.
 * activeCategoryIds includes requested layers while they are loading.
 * onEvent({ categoryId, soundIndex, duration, clipId }) marks a sample start.
 * onEvent({ categoryId, ended: true }) clears that category's current event.
 */
(function () {
  'use strict';

  const SETTINGS = {
    falling: { level: 0.65, pan: -0.48 },
    flowing: { level: 0.50, pan: -0.16 },
    bubbling: { level: 0.60, pan: 0.16 },
    mouth: { level: 0.65, pan: 0.48 }
  };
  const random = (min, max) => min + Math.random() * (max - min);

  class WaterAudio {
    constructor({ bank = {}, onState = () => {}, onEvent = () => {}, onStatus = () => {} } = {}) {
      this.supported = Boolean(window.AudioContext || window.webkitAudioContext);
      this._bank = bank;
      this._onState = onState;
      this._onEvent = onEvent;
      this._onStatus = onStatus;
      this._context = null;
      this._master = null;
      this._compressor = null;
      this._buffers = new Map();
      this._languages = new Set(['en', 'fr', 'es', 'it', 'de']);
      // Legacy nonverbal mouth effects never enter the voiced score.
      this._embeddedClips = (Array.isArray(bank.clips) ? bank.clips : [])
        .filter((clip) => clip && (clip.kind === 'word' || clip.kind === 'vocal'))
        .map((clip, index) => ({ ...clip, _cacheKey: `embedded:${index}:${clip.id}` }));
      this._vocalOverrides = new Map();
      this._takeVersions = new Map();
      this._takeSerial = 0;
      this._destroyed = false;
      this._layers = new Map(Object.entries(SETTINGS).map(([id, settings]) => [id, {
        id, ...settings, wanted: false, loading: false, token: 0, timer: null,
        gain: null, panner: null, sources: new Set(), ready: [], lastClipId: null,
        eventSerial: 0, burstRemaining: 0, eventsSinceWord: 0,
        clipVersion: 0, refreshSerial: 0, refreshing: false,
        clips: this._embeddedClips.filter((clip) => clip.categoryId === id)
      }]));
      this._emitState();
      this._onStatus(this.supported
        ? 'Start a circle to add voices. Layers can play together.'
        : 'Audio is unavailable here. Open this document in a browser with Web Audio.');
    }

    _emitState() {
      this._onState({
        activeCategoryIds: [...this._layers.values()].filter((layer) => layer.wanted).map((layer) => layer.id),
        loadingCategoryIds: [...this._layers.values()].filter((layer) => layer.wanted &&
          (layer.loading || (layer.refreshing && !this._hasEligibleClips(layer)))).map((layer) => layer.id)
      });
    }

    _ensureContext() {
      if (this._context) return this._context;
      const Context = window.AudioContext || window.webkitAudioContext;
      const context = new Context();
      this._context = context;
      this._master = context.createGain();
      // At most eight sources, each at <= .24 gain, feed this master.
      this._master.gain.value = 0.55;
      this._compressor = context.createDynamicsCompressor();
      this._compressor.threshold.value = -12;
      this._compressor.knee.value = 12;
      this._compressor.ratio.value = 5;
      this._compressor.attack.value = 0.006;
      this._compressor.release.value = 0.18;
      this._master.connect(this._compressor);
      this._compressor.connect(context.destination);
      this._layers.forEach((layer) => {
        layer.gain = context.createGain();
        layer.gain.gain.value = layer.level;
        if (context.createStereoPanner) {
          layer.panner = context.createStereoPanner();
          layer.panner.pan.value = layer.pan;
          layer.gain.connect(layer.panner);
          layer.panner.connect(this._master);
        } else layer.gain.connect(this._master);
      });
      context.onstatechange = () => {
        if (this._destroyed) return;
        if (context.state === 'suspended' || context.state === 'interrupted' || context.state === 'closed') {
          const sounding = [...this._layers.values()].some((layer) => layer.wanted && !layer.loading);
          if (sounding) {
            this._stopAll(false);
            this._onStatus('Audio was paused by your browser. Click sound circles to start the layers again.');
          }
        }
      };
      return context;
    }

    toggle(categoryId) {
      const layer = this._layers.get(categoryId);
      if (!layer || this._destroyed) return Promise.resolve(false);
      if (layer.wanted) {
        this.stop(categoryId);
        return Promise.resolve(false);
      }
      if (!this.supported) {
        this._onStatus('Audio is unavailable here. Open this document in a browser with Web Audio.');
        return Promise.resolve(false);
      }
      if (!layer.clips.length) {
        this._onStatus('This layer has no recorded words or voiced sound takes available.');
        return Promise.resolve(false);
      }

      let resume;
      try {
        const context = this._ensureContext();
        // Invoke resume within the user click, before any asynchronous decoding.
        resume = context.state === 'running' ? Promise.resolve() : context.resume();
      } catch (error) {
        this._onStatus('Audio could not start. Check your sound output or try another browser.');
        return Promise.resolve(false);
      }
      const token = ++layer.token;
      layer.wanted = true;
      layer.loading = true;
      layer.burstRemaining = 0;
      layer.eventsSinceWord = 0;
      this._emitState();
      this._onStatus('Preparing the voice takes…');

      return Promise.all([resume, this._loadLayer(layer)]).then(([, result]) => {
        if (!this._isCurrent(layer, token)) return false;
        if (this._context.state !== 'running') throw new Error('audio-blocked');
        this._mergeReady(layer, result.ready);
        if (!layer.ready.length) throw new Error('no-recordings');
        layer.loading = false;
        this._emitState();
        this._playEvent(layer, token);
        if (result.failed && layer.wanted) {
          this._onStatus('Playing the available voice takes; some clips could not be loaded.');
        } else if (layer.wanted) this._mixStatus();
        return layer.wanted;
      }).catch((error) => {
        if (!this._isCurrent(layer, token)) return false;
        this._stopLayer(layer);
        this._emitState();
        this._onStatus(error.message === 'no-recordings'
          ? 'These recordings could not be read. Other layers can keep playing.'
          : 'Audio could not start. Click the circle again to retry or check browser audio settings.');
        return false;
      });
    }

    _isCurrent(layer, token) {
      return !this._destroyed && layer.wanted && layer.token === token;
    }

    _decode(clip) {
      const key = clip._cacheKey || clip.id;
      if (this._buffers.has(key)) return this._buffers.get(key);
      const promise = Promise.resolve().then(() => {
        const encoded = String(clip.data || '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
        const binary = window.atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return this._context.decodeAudioData(bytes.buffer);
      }).then((buffer) => {
        if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error('empty-recording');
        return buffer;
      }).catch((error) => {
        if (this._buffers.get(key) === promise) this._buffers.delete(key);
        throw error;
      });
      this._buffers.set(key, promise);
      return promise;
    }

    _loadLayer(layer) {
      const version = layer.clipVersion;
      return Promise.allSettled(layer.clips.slice().map((clip) =>
        this._decode(clip).then((buffer) => ({ clip, buffer }))
      )).then((results) => {
        if (!this._destroyed && version !== layer.clipVersion) return this._loadLayer(layer);
        return {
          ready: results.filter((result) => result.status === 'fulfilled').map((result) => result.value),
          failed: results.filter((result) => result.status === 'rejected').length
        };
      });
    }

    _mergeReady(layer, entries) {
      const available = new Map([...layer.ready, ...entries].map((entry) => [entry.clip._cacheKey, entry]));
      // Intersect with the current bank so late decode results cannot restore a
      // replaced or removed take, nor overwrite a newly committed recording.
      layer.ready = layer.clips.map((clip) => available.get(clip._cacheKey)).filter(Boolean);
    }

    _hasEligibleClips(layer) {
      return layer.ready.some(({ clip }) => clip.kind === 'vocal' ||
        (clip.kind === 'word' && this._languages.has(clip.lang)));
    }

    _rebuildClips(layer, entries = []) {
      const overrides = [...this._vocalOverrides.values()].filter((clip) => clip.categoryId === layer.id);
      const replaced = new Set(overrides.map((clip) => clip.soundIndex));
      layer.clips = this._embeddedClips.filter((clip) => clip.categoryId === layer.id &&
        (clip.kind === 'word' || !replaced.has(clip.soundIndex))).concat(overrides);
      layer.clipVersion += 1;
      this._mergeReady(layer, entries);
    }

    _refreshLayer(layer) {
      const serial = ++layer.refreshSerial;
      layer.refreshing = true;
      this._emitState();
      this._loadLayer(layer).then((result) => {
        if (this._destroyed || serial !== layer.refreshSerial) return;
        this._mergeReady(layer, result.ready);
        layer.refreshing = false;
        this._emitState();
      }).catch(() => {
        if (this._destroyed || serial !== layer.refreshSerial) return;
        layer.refreshing = false;
        this._emitState();
      });
    }

    async setVocalTake(input) {
      if (this._destroyed) return null;
      if (!this.supported) throw new Error('Audio recording playback is unavailable in this browser.');
      if (!input || !this._layers.has(input.categoryId)) throw new Error('Choose a valid sound category.');
      if (!Number.isInteger(input.soundIndex) || input.soundIndex < 0 || input.soundIndex > 255) {
        throw new Error('Choose a valid sound slot.');
      }
      if (typeof input.data !== 'string' || input.data.length > 24 * 1024 * 1024) {
        throw new Error('The recording data is missing or too large.');
      }
      const data = input.data.replace(/^data:[^,]*,/, '').replace(/\s/g, '');
      if (!data || data.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new Error('Use a valid audio recording smaller than 12 MB.');
      }
      const mime = String(input.mime || 'audio/wav').trim();
      if (mime.length > 120 || !/^audio\/[a-z0-9.+-]+(?:;[^\r\n]*)?$/i.test(mime)) {
        throw new Error('Use an audio file for this voiced take.');
      }
      const serial = ++this._takeSerial;
      const id = input.id === undefined ? `vocal-${input.categoryId}-${input.soundIndex}-${serial}` : String(input.id).trim();
      if (!id || id.length > 160) throw new Error('The recording identifier is invalid.');
      const label = String(input.label || input.text || 'Voiced sound').trim().slice(0, 200);
      const clip = {
        id, categoryId: input.categoryId, soundIndex: input.soundIndex,
        kind: 'vocal', data, mime, label,
        text: String(input.text || label).trim().slice(0, 200),
        sourceId: String(input.sourceId || 'user-vocal-recording').slice(0, 160),
        _cacheKey: `user-vocal:${serial}`
      };
      if (['en', 'fr', 'es', 'it', 'de'].includes(input.lang)) clip.lang = input.lang;
      const slot = `${clip.categoryId}:${clip.soundIndex}`;
      const version = (this._takeVersions.get(slot) || 0) + 1;
      this._takeVersions.set(slot, version);
      try {
        this._ensureContext();
        const buffer = await this._decode(clip);
        if (buffer.duration < 0.05 || buffer.duration > 20) {
          throw new Error('Record or upload a voiced take lasting 0.05 to 20 seconds.');
        }
        if (this._destroyed || this._takeVersions.get(slot) !== version) {
          this._buffers.delete(clip._cacheKey);
          return null;
        }
        clip.duration = buffer.duration;
        const previous = this._vocalOverrides.get(slot);
        if (previous) this._buffers.delete(previous._cacheKey);
        this._vocalOverrides.set(slot, clip);
        const layer = this._layers.get(clip.categoryId);
        this._rebuildClips(layer, [{ clip, buffer }]);
        this._emitState();
        const { _cacheKey, ...savedTake } = clip;
        return savedTake;
      } catch (error) {
        this._buffers.delete(clip._cacheKey);
        if (this._destroyed || this._takeVersions.get(slot) !== version) return null;
        throw error;
      }
    }

    removeVocalTake(categoryId, soundIndex) {
      if (this._destroyed || !this._layers.has(categoryId) || !Number.isInteger(soundIndex) || soundIndex < 0 || soundIndex > 255) return false;
      const slot = `${categoryId}:${soundIndex}`;
      this._takeVersions.set(slot, (this._takeVersions.get(slot) || 0) + 1);
      const previous = this._vocalOverrides.get(slot);
      if (previous) this._buffers.delete(previous._cacheKey);
      this._vocalOverrides.delete(slot);
      const layer = this._layers.get(categoryId);
      this._rebuildClips(layer);
      if (layer.wanted && !layer.loading) this._refreshLayer(layer);
      this._emitState();
      return Boolean(previous);
    }

    _playEvent(layer, token) {
      if (!this._isCurrent(layer, token)) return;
      if (this._context.state !== 'running') {
        this._stopLayer(layer);
        this._emitState();
        this._onStatus('Audio is paused. Click the circle to start this layer again.');
        return;
      }
      if (layer.sources.size >= 2) {
        layer.timer = window.setTimeout(() => this._playEvent(layer, token), 180);
        return;
      }

      let source;
      let envelope;
      try {
        const vocal = layer.ready.filter((entry) => entry.clip.kind === 'vocal');
        const words = layer.ready.filter((entry) => entry.clip.kind === 'word' && this._languages.has(entry.clip.lang));
        const useWord = words.length > 0 && (vocal.length === 0 || layer.eventsSinceWord >= 3 || (layer.eventsSinceWord > 0 && Math.random() < 0.28));
        const pool = useWord ? words : vocal.length ? vocal : words;
        if (!pool.length) {
          if (layer.refreshing) {
            layer.timer = window.setTimeout(() => this._playEvent(layer, token), 180);
            return;
          }
          throw new Error('no-eligible-recordings');
        }
        const choices = pool.length > 1 ? pool.filter((entry) => entry.clip.id !== layer.lastClipId) : pool;
        const { clip, buffer } = choices[Math.floor(Math.random() * choices.length)];
        layer.eventsSinceWord = useWord ? 0 : layer.eventsSinceWord + 1;
        const context = this._context;
        const rate = clip.kind === 'word' ? random(0.99, 1.01) : random(0.97, 1.03);
        const duration = buffer.duration / rate;
        const start = context.currentTime + 0.015;
        source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        envelope = context.createGain();
        const level = clip.kind === 'word' ? random(0.21, 0.24) : random(0.16, 0.20);
        const attack = Math.min(layer.id === 'flowing' ? 0.035 : 0.006, duration * 0.12);
        const release = Math.min(layer.id === 'flowing' ? 0.14 : 0.045, duration * 0.20);
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(level, start + attack);
        envelope.gain.setValueAtTime(level, start + duration - release);
        envelope.gain.linearRampToValueAtTime(0, start + duration);
        source.connect(envelope);
        envelope.connect(layer.gain);
        if (layer.panner) layer.panner.pan.setTargetAtTime(layer.pan + random(-0.05, 0.05), context.currentTime, 0.2);
        const serial = ++layer.eventSerial;
        const event = { source, envelope, serial };
        layer.sources.add(event);
        layer.lastClipId = clip.id;
        source.onended = () => {
          const wasTracked = layer.sources.delete(event);
          source.disconnect();
          envelope.disconnect();
          if (wasTracked && this._isCurrent(layer, token) && serial === layer.eventSerial) {
            this._onEvent({ categoryId: layer.id, ended: true, clipId: clip.id });
          }
        };
        source.start(start);
        this._onEvent({ categoryId: layer.id, soundIndex: clip.soundIndex, duration, clipId: clip.id, kind:clip.kind, wordId:clip.wordId, text:clip.text, lang:clip.lang });
        const gap = clip.kind === 'word' ? duration + random(0.3, 1.1) : this._nextGap(layer, duration);
        layer.timer = window.setTimeout(() => this._playEvent(layer, token), gap * 1000);
      } catch (error) {
        if (source) { try { source.stop(); } catch (ignored) {} }
        if (source) { try { source.disconnect(); } catch (ignored) {} }
        if (envelope) { try { envelope.disconnect(); } catch (ignored) {} }
        if (!this._isCurrent(layer, token)) return;
        this._stopLayer(layer);
        this._emitState();
        this._onStatus('This layer could not play. The other layers can continue; click its circle to retry.');
      }
    }

    _nextGap(layer, duration) {
      if (layer.id === 'flowing') return Math.max(0.40, duration * random(0.74, 0.93));
      if (layer.id === 'mouth') return duration + random(0.45, 1.60);
      if (layer.id === 'falling') return Math.max(0.22, duration * random(0.55, 1.15)) + random(0.12, 0.65);
      if (layer.burstRemaining > 0) {
        layer.burstRemaining -= 1;
        return random(0.13, 0.32);
      }
      layer.burstRemaining = Math.floor(random(1, 4));
      return duration + random(0.35, 1.10);
    }

    _stopLayer(layer) {
      layer.token += 1;
      layer.wanted = false;
      layer.loading = false;
      window.clearTimeout(layer.timer);
      layer.timer = null;
      const context = this._context;
      const now = context ? context.currentTime : 0;
      const fade = context && context.state === 'running' ? 0.065 : 0;
      layer.sources.forEach((event) => {
        const { source, envelope } = event;
        try {
          envelope.gain.cancelScheduledValues(now);
          envelope.gain.setValueAtTime(envelope.gain.value, now);
          envelope.gain.linearRampToValueAtTime(0, now + fade);
          source.stop(now + fade + 0.005);
        } catch (error) {
          try { source.disconnect(); } catch (ignored) {}
          try { envelope.disconnect(); } catch (ignored) {}
          layer.sources.delete(event);
        }
      });
      this._onEvent({ categoryId: layer.id, ended: true });
    }

    stop(categoryId) {
      const layer = this._layers.get(categoryId);
      if (!layer) return;
      this._stopLayer(layer);
      this._emitState();
      this._mixStatus();
    }

    _stopAll(announce) {
      this._layers.forEach((layer) => this._stopLayer(layer));
      this._emitState();
      if (announce) this._onStatus('All layers stopped. Start any circles to build a new atmosphere.');
    }

    stopAll() { this._stopAll(true); }

    _mixStatus() {
      const count = [...this._layers.values()].filter((layer) => layer.wanted && !layer.loading).length;
      const loading = [...this._layers.values()].filter((layer) => layer.loading).length;
      if (loading) {
        this._onStatus(`Preparing ${loading} voice ${loading === 1 ? 'layer' : 'layers'}${count ? `; ${count} already playing` : ''}…`);
        return;
      }
      this._onStatus(count
        ? `${count} voice ${count === 1 ? 'layer is' : 'layers are'} playing. Add another circle or click an active circle to stop it.`
        : 'Start any circles to layer their voices.');
    }

    setLevel(categoryId, level) {
      const layer = this._layers.get(categoryId);
      if (!layer || !Number.isFinite(level)) return;
      layer.level = Math.max(0, Math.min(1, level));
      if (layer.gain && this._context) {
        layer.gain.gain.setTargetAtTime(layer.level, this._context.currentTime, 0.035);
      }
    }

    setLanguages(languages) {
      this._languages = new Set(Array.from(languages || []).filter((lang) => ['en','fr','es','it','de'].includes(lang)));
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._stopAll(false);
      this._buffers.clear();
      if (this._context && this._context.state !== 'closed') this._context.close().catch(() => {});
    }
  }

  window.WaterAudio = WaterAudio;
}());
