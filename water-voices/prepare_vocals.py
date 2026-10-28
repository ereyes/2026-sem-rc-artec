"""Prepare spoken onomatopoeias. No water, gargling, or mouth Foley is used.

Default: build from downloaded originals. --download retrieves missing public
recordings slowly and respects rate-limit responses without repeated requests.
"""
import base64
import io
import json
import math
import struct
import subprocess
import sys
import time
import wave
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parent
manifest = json.loads((root/"vocal-sources.json").read_text())
originals = root/"assets/vocal-originals"
originals.mkdir(exist_ok=True)
download = "--download" in sys.argv
old_bank = json.loads((root/"audio-bank.json").read_text())
existing_path = root/'vocal-bank.json'
existing = json.loads(existing_path.read_text()) if existing_path.exists() else {"clips":[],"sources":[]}
clips = [clip for clip in existing['clips'] if clip.get('provenance')=='generated']
generated_sources = {clip['sourceId'] for clip in clips}
sources = [source for source in existing['sources'] if source['id'] in generated_sources]
for item in manifest:
    clip_id = item["id"]
    if item.get("reuseClipId"):
        original = next(clip for clip in old_bank["clips"] if clip["id"]==item["reuseClipId"])
        payload = base64.b64decode(original["data"])
        duration = original["duration"]
    else:
        source = originals/f"{clip_id}.{item['extension']}"
        pcm_path = originals/f"{clip_id}.pcm.wav"
        if not source.exists() and download:
            try:
                request = Request(item["downloadUrl"],headers={"User-Agent":"WaterVoicesPrototype/1.0 (educational audio artwork)"})
                with urlopen(request,timeout=30) as response:
                    data = response.read()
                source.write_bytes(data)
                print(f"Downloaded {item['text']}",flush=True)
                time.sleep(20)
            except HTTPError as error:
                print(f"Download deferred for {item['text']}: HTTP {error.code}; Retry-After {error.headers.get('Retry-After','unspecified')}. No further requests to that file.",flush=True)
                if error.code==429:
                    download=False
                continue
        if not source.exists():
            print(f"No default voice take yet: {item['text']}",flush=True)
            continue
        if not pcm_path.exists():
            subprocess.run(["/usr/bin/afconvert",str(source),str(pcm_path),"-f","WAVE","-d","LEI16@22050","-c","1"],check=True,capture_output=True)
        with wave.open(str(pcm_path)) as audio:
            rate=audio.getframerate()
            assert audio.getnchannels()==1 and audio.getsampwidth()==2
            raw=audio.readframes(audio.getnframes())
        signal=struct.unpack("<"+"h"*(len(raw)//2),raw)
        hop=max(1,round(rate*.02))
        energy=[math.sqrt(sum(s*s for s in signal[i:i+hop])/len(signal[i:i+hop])) for i in range(0,len(signal),hop)]
        audible=[i for i,value in enumerate(energy) if value>max(energy)*.025]
        assert audible,clip_id
        first=max(0,audible[0]*hop-round(.08*rate))
        last=min(len(signal),(audible[-1]+1)*hop+round(.08*rate))
        samples=list(signal[first:last]);mean=sum(samples)/len(samples)
        samples=[sample-mean for sample in samples]
        gain=min(4.0,.72*32767/max(abs(sample) for sample in samples))
        fade=min(round(.005*rate),len(samples)//8)
        for i in range(fade):samples[i]*=i/fade;samples[-1-i]*=i/fade
        pcm=[max(-32768,min(32767,round(sample*gain))) for sample in samples]
        buffer=io.BytesIO()
        with wave.open(buffer,"wb") as audio:
            audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(rate)
            audio.writeframes(struct.pack("<"+"h"*len(pcm),*pcm))
        payload=buffer.getvalue();duration=len(pcm)/rate
    clips.append({"id":clip_id,"kind":"vocal","categoryId":item["categoryId"],"soundIndex":item["soundIndex"],"text":item["text"],"label":f"Voice · {item['text']}","sourceId":clip_id,"duration":round(duration,4),"mime":"audio/wav","data":base64.b64encode(payload).decode()})
    sources.append({key:value for key,value in item.items() if key in {"id","title","author","license","licenseUrl","url"}})
    print(f"Voiced {item['text']}: {duration:.2f}s",flush=True)
(root/"vocal-bank.json").write_text(json.dumps({"clips":clips,"sources":sources},ensure_ascii=False,separators=(",",":")))
print(f"Prepared {len(clips)} actual voiced onomatopoeias.",flush=True)
