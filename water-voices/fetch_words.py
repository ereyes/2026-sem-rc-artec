"""Download attributed human word recordings and convert them with macOS afconvert."""
import json
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parent
out = root / "assets/word-originals"
out.mkdir(exist_ok=True)
items = []
for manifest in sorted((root / "assets").glob("word-sources-*.json")):
    items.extend(json.loads(manifest.read_text()))

failures = []
if any(not (out / item.get("reuseFrom",f"word-{item['categoryId']}-{item['lang']}.pcm.wav")).exists() for item in items):
    print("Waiting 30s before downloading remaining files; new downloads are spaced 16s apart.", flush=True)
    time.sleep(30)
for item in items:
    category, lang = item["categoryId"], item["lang"]
    assert category in {"falling", "flowing", "bubbling", "mouth"}
    assert lang in {"en", "fr", "es", "it", "de"}
    if item.get("reuseFrom"):
        assert Path(item["reuseFrom"]).name == item["reuseFrom"]
        assert (out/item["reuseFrom"]).exists()
        print(f"{category} / {lang.upper()} / {item['text']}: shared recording ready", flush=True)
        continue
    url = quote(item["downloadUrl"], safe=":/?&=%")
    assert urlparse(url).hostname == "upload.wikimedia.org"
    extension = Path(item["filename"]).suffix
    assert extension in {".ogg", ".wav"}
    target = out / f"word-{category}-{lang}{extension}"
    pcm = target.with_suffix(".pcm.wav")
    try:
        downloaded = False
        if not target.exists():
            for attempt in range(3):
                try:
                    request = Request(url, headers={"User-Agent":"WaterVoicesPrototype/1.0 (educational audio artwork)"})
                    with urlopen(request, timeout=30) as response:
                        payload = response.read()
                    target.write_bytes(payload)
                    downloaded = True
                    break
                except HTTPError as error:
                    if error.code != 429 or attempt == 2:
                        raise
                    retry = error.headers.get("Retry-After", "20")
                    delay = int(retry) if retry.isdigit() else 20
                    delay = max(20, delay)
                    print(f"Rate limit; waiting {delay}s before retrying {item['text']}", flush=True)
                    time.sleep(delay)
        if not pcm.exists() or pcm.stat().st_size < 100:
            subprocess.run(["/usr/bin/afconvert", str(target), str(pcm), "-f", "WAVE", "-d", "LEI16@22050", "-c", "1"], check=True, capture_output=True)
        print(f"{category} / {lang.upper()} / {item['text']}: ready", flush=True)
        if downloaded:
            time.sleep(16)
    except Exception as error:
        failures.append(f"{category}/{lang}: {error}")
        print(f"Deferred {category}/{lang}: {error}", flush=True)

if failures:
    raise SystemExit("\n".join(failures))
print(f"All {len(items)} word recordings prepared.", flush=True)
