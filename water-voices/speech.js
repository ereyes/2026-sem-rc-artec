/* Browser speech for the water score. No audio is started until play() is called.
 * onState({ categoryId, playing })
 * onWord({ categoryId, item, index, total }) on speech start; null to clear.
 * onStatus(message)
 */
(function () {
  'use strict';

  const LOCALES = { en: 'en-GB', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', de: 'de-DE' };
  const LABELS = { en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', de: 'German' };
  const normalize = (lang) => String(lang || '').replace(/_/g, '-').toLowerCase();

  class WaterSpeech {
    constructor({ onState = () => {}, onWord = () => {}, onStatus = () => {} } = {}) {
      this._onState = onState;
      this._onWord = onWord;
      this._onStatus = onStatus;
      this.supported = Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);
      this._synth = this.supported ? window.speechSynthesis : null;
      this._voices = [];
      this._token = 0;
      this._timer = null;
      this._watchdog = null;
      this._utterance = null;
      this._categoryId = null;
      this._playing = false;
      this._items = [];
      this._index = 0;
      this._onVoicesChanged = () => this._loadVoices();

      if (this.supported) {
        this._synth.addEventListener('voiceschanged', this._onVoicesChanged);
        this._loadVoices();
      } else {
        this._onStatus('Speech is unavailable here. Open this document in a browser with speech synthesis.');
      }
      this._onState({ categoryId: null, playing: false });
    }

    _loadVoices() {
      this._voices = Array.from(this._synth.getVoices());
      if (!this._playing) {
        this._onStatus('Choose a sound button to hear its words and sounds.');
      }
    }

    _chooseVoice(lang) {
      const locale = normalize(LOCALES[lang] || lang);
      const base = locale.split('-')[0];
      const exact = this._voices.filter((voice) => normalize(voice.lang) === locale);
      const related = this._voices.filter((voice) => normalize(voice.lang).split('-')[0] === base);
      const candidates = exact.length ? exact : related;
      return candidates.find((voice) => voice.localService) ||
        candidates.find((voice) => voice.default) || candidates[0] || null;
    }

    getVoiceSummary() {
      if (this.supported) this._voices = Array.from(this._synth.getVoices());
      return Object.entries(LOCALES).map(([lang, locale]) => {
        const voice = this._chooseVoice(lang);
        return { lang, locale, available: Boolean(voice), voiceName: voice ? voice.name : null };
      });
    }

    play(categoryId, items) {
      if (!this.supported) {
        this._onStatus('Speech is unavailable here. Open this document in a browser with speech synthesis.');
        return false;
      }
      if (this._playing && this._categoryId === categoryId) {
        this.stop();
        return false;
      }

      const playlist = Array.isArray(items) ? items.filter((item) =>
        item && typeof (item.say || item.text) === 'string' && (item.say || item.text).trim()
      ) : [];
      this._reset();
      if (!playlist.length) {
        this._onStatus('There are no words or sounds to read in this section.');
        return false;
      }

      this._voices = Array.from(this._synth.getVoices());
      this._items = playlist.slice();
      this._categoryId = categoryId;
      this._playing = true;
      this._onState({ categoryId, playing: true });
      this._onStatus('Starting voice. Press the same sound button to stop.');
      // Keep the first speak() in the original user-click call stack.
      this._speakNext(this._token);
      return true;
    }

    _speakNext(token) {
      if (token !== this._token || !this._playing) return;
      if (this._index >= this._items.length) {
        this._reset();
        this._onStatus('Voice finished. Choose a sound button to listen again.');
        return;
      }

      const item = this._items[this._index];
      const lang = normalize(item.lang).split('-')[0];
      const phrase = (item.say || item.text).trim();
      const utterance = new window.SpeechSynthesisUtterance(phrase);
      const voice = this._chooseVoice(lang);
      utterance.lang = LOCALES[lang] || item.lang || LOCALES.en;
      if (voice) utterance.voice = voice;
      utterance.rate = Number.isFinite(item.rate) ? Math.max(0.5, Math.min(1.5, item.rate)) : 0.88;
      utterance.pitch = Number.isFinite(item.pitch) ? Math.max(0.5, Math.min(1.5, item.pitch)) : 1;
      this._utterance = utterance;

      utterance.onstart = () => {
        if (token !== this._token) return;
        this._onWord({ categoryId: this._categoryId, item, index: this._index, total: this._items.length });
        const fallback = voice ? '' : ` · ${LABELS[lang] || 'Language'} pronunciation requested from your browser`;
        this._onStatus(`${String(lang || 'en').toUpperCase()} · ${item.text}${fallback}`);
      };
      utterance.onend = () => {
        if (token !== this._token) return;
        window.clearTimeout(this._watchdog);
        this._watchdog = null;
        this._utterance = null;
        this._index += 1;
        this._onWord(null);
        this._timer = window.setTimeout(() => this._speakNext(token), 260);
      };
      utterance.onerror = (event) => {
        if (token !== this._token) return;
        const message = this._errorMessage(event.error, lang);
        this._reset();
        this._onStatus(message);
      };

      // Short score fragments should finish well before this. Prevent a browser
      // which emits neither end nor error from leaving the stop state stuck.
      this._watchdog = window.setTimeout(() => {
        if (token !== this._token) return;
        this._reset();
        this._onStatus('The voice did not finish. Press a sound button to try again.');
      }, Math.max(25000, Math.min(120000, phrase.length * 400)));

      try {
        if (this._synth.paused) this._synth.resume();
        this._synth.speak(utterance);
      } catch (error) {
        if (token !== this._token) return;
        this._reset();
        this._onStatus('Speech could not start. Press the sound button again or try another browser.');
      }
    }

    _errorMessage(error, lang) {
      if (error === 'not-allowed') return 'Your browser blocked speech. Click the sound button again or enable speech in your browser.';
      if (error === 'network') return 'The voice could not connect. Check your connection and try again.';
      if (error === 'voice-unavailable' || error === 'language-unavailable') {
        return `A ${LABELS[lang] || 'requested'} voice could not be used. Add a voice for this language in your device settings, then reload.`;
      }
      if (error === 'canceled' || error === 'interrupted') return 'Voice interrupted. Choose a sound button to start again.';
      if (error === 'audio-busy' || error === 'audio-hardware') return 'Audio is unavailable. Check your sound output and try again.';
      return 'The voice could not play. Press the sound button again or try another browser.';
    }

    _reset() {
      // Invalidate callbacks before cancel(), which can emit synchronous errors.
      this._token += 1;
      window.clearTimeout(this._timer);
      window.clearTimeout(this._watchdog);
      this._timer = null;
      this._watchdog = null;
      if (this._utterance) {
        this._utterance.onstart = null;
        this._utterance.onend = null;
        this._utterance.onerror = null;
      }
      this._utterance = null;
      this._playing = false;
      this._categoryId = null;
      this._items = [];
      this._index = 0;
      if (this._synth) this._synth.cancel();
      this._onWord(null);
      this._onState({ categoryId: null, playing: false });
    }

    stop() {
      const wasPlaying = this._playing;
      this._reset();
      if (wasPlaying) this._onStatus('Voice stopped. Choose a sound button to listen again.');
    }

    destroy() {
      this.stop();
      if (this._synth) this._synth.removeEventListener('voiceschanged', this._onVoicesChanged);
    }
  }

  window.WaterSpeech = WaterSpeech;
}());
