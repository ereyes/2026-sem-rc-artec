"""Assemble a standalone HTML document, with no network dependencies."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
template = (root / "template.html").read_text()
data = json.loads((root / "inventory.json").read_text())
parts = {
    "/* __STYLES__ */": (root / "style.css").read_text(),
    "/* __DATA__ */": json.dumps(data, ensure_ascii=False).replace("</", "<\\/"),
    "/* __SPEECH__ */": (root / "speech.js").read_text(),
    "/* __APP__ */": (root / "app.js").read_text(),
}
for marker, content in parts.items():
    assert template.count(marker) == 1, marker
    template = template.replace(marker, content)
target = root / "index.html"
target.write_text(template)
print(f"Built {target} ({target.stat().st_size:,} bytes)")
