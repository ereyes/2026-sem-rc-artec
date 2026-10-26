# Eau / Voix

Open `index.html` directly in a web browser. It is a standalone HTML document with its styles, vocabulary, and JavaScript included; no installation or server is needed.

The four vertical sections group the original water inventory by movement:

| Family | Material | Motion |
| --- | --- | --- |
| Falling / Tomber | Drops, rain, splashes | Falling |
| Flowing / Couler | Taps, streams, pouring, waves, spray | Sideways currents |
| Bubbling / Bouillonner | Air and water, bottles, boiling, drains | Circling |
| Mouth & water / Boire | Sipping, swallowing, gargling | Drawing inward |

Each section has two words per language (EN, FR, ES, IT, DE) and five shared vocal experiments. The Inventory button opens the full table with all 24 original events and their physical sources. Squeezing water from fabric appears in both Falling and Flowing.

Click a section's circular speaker button for one complete sequence. Click again to stop, or choose another section to switch. Language buttons filter the words and choose the pronunciation languages for the sound spellings. All five sound spellings remain in each sequence. Escape stops speech. The pause button controls the animation; reduced-motion preferences are respected. On narrow screens, swipe horizontally between sections.

Speech uses the browser's Web Speech API. Available voices depend on the device and browser; the Inventory view lists the matching voices. Text-to-speech interprets the experimental sound spellings as speech and cannot guarantee a particular throat effect or exact duration for a repeated letter. See [MDN SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis).

To edit, change `inventory.json`, `style.css`, `app.js`, `speech.js`, or `template.html`, then run `python3 build.py` to regenerate `index.html`.
