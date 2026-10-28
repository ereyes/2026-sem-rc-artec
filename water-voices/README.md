# Water voices

Open `index.html` directly in a web browser. It is a standalone HTML document with its styles, vocabulary, and JavaScript included; no installation or server is needed.

The four vertical sections group the original water inventory by movement:

| Family | Material | Motion |
| --- | --- | --- |
| Falling / Tomber | Drops, rain, splashes | Falling |
| Flowing / Couler | Taps, streams, pouring, waves, spray | Sideways currents |
| Bubbling / Bouillonner | Air and water, bottles, boiling, drains | Circling |
| Mouth & water / Boire | Sipping, swallowing, gargling | Drawing inward |

Each section has a word bank in EN, FR, ES, IT, and DE, plus five shared vocal experiments. The Inventory button opens the full table with all 24 original events and their physical sources. Squeezing water from fabric appears in both Falling and Flowing.

Click a section's circular speaker button to add its repeating voice layer. Other sections can play at the same time. Click an active circle to stop only that layer; use its Level slider to change its volume. Stop all or Escape silences every layer. The language buttons choose the visible words and the languages of future recorded word events without interrupting the vocal sounds. The pause button controls animation; reduced-motion preferences are respected. All four sections stay side by side as the window resizes; text and controls scale with each panel. Language labels remain in the toolbar and Inventory, while animated words appear on their own.

All twenty sound prompts have vocal takes. Eight use recorded examples (plop, ploc, plouf, shhh, glou-glou, glug, slurp, and ah); the remaining twelve were generated locally with Kokoro-82M’s af_heart stock voice. They play alongside 20 recorded-word slots drawn from 18 human pronunciations. The engine accepts only explicit word and vocal clips. No Runway account or microphone recording is needed to use the complete palette.

Use Voices beside a section's level control, or Preview or replace voices inside Inventory. Select a sound and preview its included take. You can optionally record or import a replacement and choose Use take. The previous take stays in place until its replacement is accepted. Replacements are kept in browser storage when available; Download HTML embeds accepted takes in a portable document. Microphone access begins only when you click Record. Previewing and recording pause the current mix. Language buttons select the recorded lexical words; the onomatopoeia takes are shared across languages.

Each layer has irregular timing and small playback-rate and level variations. Up to two voice fragments can overlap in each category, with the categories spread across the stereo field. See [AUDIO-CREDITS.md](AUDIO-CREDITS.md) for performers, sources, recording licenses, and edits. Prepared clips retain their listed source licenses.

To edit, change `inventory.json`, `style.css`, `app.js`, `audio.js`, `voice-studio.js`, or `template.html`, then run `python3 build.py` to regenerate the finished `index.html`. The template is build source. The build embeds the word recordings from `audio-bank.json` and voiced onomatopoeias from `vocal-bank.json`, so the finished HTML needs no network requests or separate audio files. `prepare_audio.py` and `prepare_vocals.py` document the source edits. Legacy mouth-Foley assets remain archived in the project but are excluded from the build and from playback.

The generated audio files are in `assets/generated-vocals/`. `generated-vocals-manifest.json` records phonemes, voice, speed, checksums, and durations. Regenerate them with `generate_onomatopoeias.py` in an isolated kokoro-onnx environment and explicit `--model`/`--voices` paths. Model weights are not included in the HTML.
