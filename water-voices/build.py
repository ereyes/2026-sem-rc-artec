"""Assemble a standalone HTML document, with no network dependencies."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
template = (root / "template.html").read_text()
data = json.loads((root / "inventory.json").read_text())
audio = json.loads((root / "audio-bank.json").read_text())
vocals = json.loads((root / "vocal-bank.json").read_text())
audio["clips"] = [clip for clip in audio["clips"] if clip.get("kind") == "word"] + vocals["clips"]
used_sources = {clip["sourceId"] for clip in audio["clips"]}
source_map = {source["id"]:source for source in [*audio["sources"], *vocals["sources"]]}
audio["sources"] = [source for source in source_map.values() if source["id"] in used_sources]
if "--allow-partial" not in sys.argv:
    assert sum(clip.get("kind") == "word" for clip in audio["clips"]) == 20, "Prepare all 20 word recordings before the final build"
    expected = {(cat["id"], index) for cat in data["categories"] for index in range(len(cat["sounds"]))}
    actual = {(clip["categoryId"], clip["soundIndex"]) for clip in audio["clips"] if clip.get("kind") == "vocal"}
    assert actual == expected, "Prepare a vocal take for every sound before the final build"
parts = {
    "/* __STYLES__ */": (root / "style.css").read_text(),
    "/* __DATA__ */": json.dumps(data, ensure_ascii=False).replace("</", "<\\/"),
    "/* __AUDIO_DATA__ */": json.dumps(audio, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"),
    "/* __AUDIO__ */": (root / "audio.js").read_text(),
    "/* __STUDIO__ */": (root / "voice-studio.js").read_text(),
    "/* __APP__ */": (root / "app.js").read_text(),
}
for marker, content in parts.items():
    assert template.count(marker) == 1, marker
    template = template.replace(marker, content)
target = root / "index.html"
target.write_text(template)
print(f"Built {target} ({target.stat().st_size:,} bytes)")
