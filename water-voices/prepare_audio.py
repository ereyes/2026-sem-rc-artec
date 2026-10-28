"""Trim licensed human recordings into a small, embedded PCM sample bank.

Sources live in assets/originals/. See AUDIO-CREDITS.md for provenance.
Run after converting originals to mono 22050 Hz PCM WAV (afconvert on macOS).
Only trimming, a short edge fade, DC removal, and level adjustment are applied.
"""
import base64
import io
import json
import math
import struct
import sys
import wave
from pathlib import Path

root = Path(__file__).resolve().parent
allow_partial = "--allow-partial" in sys.argv
sources = [
    {"id":"pop","title":"Mouth pop","author":"cori / Cori Samuel","license":"Public domain","url":"https://commons.wikimedia.org/wiki/File:Mouth_pop.ogg","file":"mouth-pop.wav"},
    {"id":"breath","title":"Windy breath","author":"stilgar","license":"Public domain","url":"https://commons.wikimedia.org/wiki/File:Windy_breath.ogg","file":"windy-breath.wav"},
    {"id":"wet-mouth","title":"Mouth Noises #1","author":"DavidGreck","license":"CC0","url":"https://bigsoundbank.com/mouth-noises-1-s0352.html","file":"mouth-noises.wav"},
    {"id":"gargle","title":"Gargle #2","author":"Joseph Sardin","license":"CC0","url":"https://bigsoundbank.com/gargle-2-s1653.html","file":"gargle.wav"},
    {"id":"slurp","title":"Slurp.wav","author":"abstraktgeneriert / Agaxly","license":"CC0","url":"https://freesound.org/people/abstraktgeneriert/sounds/194466/","file":"slurp.wav"},
    {"id":"drink","title":"Drinking.wav","author":"craigglenday","license":"CC0","url":"https://freesound.org/people/craigglenday/sounds/517173/","file":"drinking.wav"}
]
regions = {
    "falling": [
        ("pop",1.00,1.25,"lip pop",0), ("pop",2.45,2.70,"cheek pop",1),
        ("pop",3.50,3.75,"lip pop",2), ("pop",5.70,5.98,"mouth click",3),
        ("pop",8.34,8.68,"rounded pop",4), ("pop",10.04,10.32,"cheek pop",2)
    ],
    "flowing": [
        ("breath",.17,4.63,"breath",0), ("breath",5.22,8.60,"blown breath",1),
        ("breath",8.65,11.73,"breath",2), ("breath",12.17,16.15,"long exhale",3),
        ("breath",16.2,20.08,"blown breath",4)
    ],
    "bubbling": [
        ("gargle",.04,.72,"throat bubbles",0), ("gargle",.63,1.30,"gargle",1),
        ("gargle",1.18,1.93,"throat bubbles",2),
        ("wet-mouth",2.40,3.25,"wet mouth gesture",3), ("wet-mouth",3.43,4.12,"lip bubbles",4)
    ],
    "mouth": [
        ("slurp",.62,1.94,"slurp",0), ("drink",.18,.76,"gulp",1),
        ("wet-mouth",.18,.58,"lip smack",2), ("gargle",.12,1.60,"gargle",3),
        ("slurp",2.66,3.75,"vocal exhale",4), ("drink",2.57,3.90,"ah",4)
    ]
}
decoded = {}
for source in sources:
    with wave.open(str(root / "assets/originals" / source["file"])) as audio:
        assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
        rate = audio.getframerate()
        raw = audio.readframes(audio.getnframes())
    decoded[source["id"]] = (rate, struct.unpack("<" + "h" * (len(raw)//2), raw))

clips = []
out = root / "assets/clips"
out.mkdir(parents=True, exist_ok=True)
for category, fragments in regions.items():
    for index, (source_id, start, end, label, sound_index) in enumerate(fragments):
        rate, signal = decoded[source_id]
        samples = list(signal[round(start*rate):round(end*rate)])
        mean = sum(samples) / len(samples)
        samples = [sample-mean for sample in samples]
        peak = max(abs(sample) for sample in samples)
        gain = min(5.0, .72*32767/max(peak, 1))
        fade = min(round(.008*rate), len(samples)//8)
        for i in range(fade):
            samples[i] *= i/fade
            samples[-1-i] *= i/fade
        pcm = [max(-32768, min(32767, round(sample*gain))) for sample in samples]
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(rate)
            audio.writeframes(struct.pack("<" + "h" * len(pcm), *pcm))
        clip_id = f"{category}-{index}"
        payload = buffer.getvalue()
        (out / f"{clip_id}.wav").write_bytes(payload)
        clips.append({"id":clip_id,"categoryId":category,"soundIndex":sound_index,"label":label,"sourceId":source_id,"duration":round(len(pcm)/rate,4),"mime":"audio/wav","data":base64.b64encode(payload).decode(),"sourceStart":start,"sourceEnd":end})

word_sources = []
for manifest in sorted((root / "assets").glob("word-sources-*.json")):
    word_sources.extend(json.loads(manifest.read_text()))
assert len(word_sources) == 20, "All four categories need a recorded word in each language"
inventory = json.loads((root / "inventory.json").read_text())
recorded_sources = []
for source in word_sources:
    category, lang = source["categoryId"], source["lang"]
    clip_id = f"word-{category}-{lang}"
    original = root / "assets/word-originals" / source.get("reuseFrom", f"{clip_id}.pcm.wav")
    if allow_partial and not original.exists():
        continue
    with wave.open(str(original)) as audio:
        rate = audio.getframerate()
        assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
        raw = audio.readframes(audio.getnframes())
    signal = struct.unpack("<" + "h" * (len(raw)//2), raw)
    hop = max(1, round(rate*.02))
    energy = [math.sqrt(sum(s*s for s in signal[i:i+hop])/len(signal[i:i+hop])) for i in range(0,len(signal),hop)]
    audible = [i for i, rms in enumerate(energy) if rms > max(energy)*.025]
    assert audible, clip_id
    first = max(0, audible[0]*hop-round(.10*rate))
    last = min(len(signal), (audible[-1]+1)*hop+round(.10*rate))
    samples = list(signal[first:last])
    mean = sum(samples)/len(samples)
    samples = [sample-mean for sample in samples]
    peak = max(abs(sample) for sample in samples)
    gain = min(5.0, .72*32767/max(peak,1))
    fade = min(round(.005*rate), len(samples)//8)
    for i in range(fade):
        samples[i] *= i/fade
        samples[-1-i] *= i/fade
    pcm = [max(-32768,min(32767,round(sample*gain))) for sample in samples]
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(rate)
        audio.writeframes(struct.pack("<" + "h"*len(pcm),*pcm))
    payload = buffer.getvalue()
    (out / f"{clip_id}.wav").write_bytes(payload)
    words = next(cat["words"] for cat in inventory["categories"] if cat["id"] == category)
    word_index = next(i for i, word in enumerate(words) if word["lang"] == lang and word["text"] == source["text"])
    clips.append({"id":clip_id,"kind":"word","categoryId":category,"wordId":f"{category}-word-{word_index}","text":source["text"],"lang":lang,"label":source["text"],"sourceId":clip_id,"duration":round(len(pcm)/rate,4),"mime":"audio/wav","data":base64.b64encode(payload).decode(),"sourceStart":round(first/rate,4),"sourceEnd":round(last/rate,4)})
    recorded_sources.append(source)

bank_sources = [{k:v for k,v in source.items() if k != "file"} for source in sources]
bank_sources.extend({"id":f"word-{source['categoryId']}-{source['lang']}","title":f"{source['lang'].upper()} · {source['text']}","author":source["author"].replace("\n","; "),"license":source["license"],"licenseUrl":source["licenseUrl"],"url":source["url"]} for source in recorded_sources)
bank = {"clips":clips,"sources":bank_sources}
(root / "audio-bank.json").write_text(json.dumps(bank, ensure_ascii=False, separators=(",",":")))
credits = root / "AUDIO-CREDITS.md"
text = credits.read_text().split("\n## Recorded words")[0]
text += "\n## Recorded words\n\nThese are human pronunciations from Wikimedia Commons / Wiktionary. Prepared fragments retain the license listed for each original recording. Edits: silence trimmed, mono conversion to 22.05 kHz PCM, DC removal, short edge fade, and level adjustment. Playback speed varies by at most one percent.\n\n| Word | Author | License | Original recording |\n| --- | --- | --- | --- |\n"
for source in recorded_sources:
    author = source["author"].replace("\n", "; ").replace("|", "/")
    text += f"| {source['lang'].upper()} · {source['text']} | {author} | [{source['license']}]({source['licenseUrl']}) | [Commons file]({source['url']}) |\n"
credits.write_text(text)
print(f"Prepared {len(clips)} human audio fragments, including {len(recorded_sources)} recorded-word slots; {sum(clip['duration'] for clip in clips):.1f} seconds; {len(json.dumps(bank)):,} embedded JSON bytes.")
