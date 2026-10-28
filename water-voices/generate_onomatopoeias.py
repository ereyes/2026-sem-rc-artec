"""Generate the twelve invented vocal takes locally with Kokoro ONNX.

Run with the isolated kokoro-onnx Python runtime and explicit model paths.
The model and voice vectors are downloaded separately from the official
thewh1teagle/kokoro-onnx model-files-v1.1 release. No account/API key is used.
"""
import argparse
import base64
import hashlib
import importlib.metadata
import json
import time
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--voices', required=True)
parser.add_argument('--voice', default='af_heart')
args = parser.parse_args()
root = Path(__file__).resolve().parent
output = root/'assets/generated-vocals'
output.mkdir(parents=True, exist_ok=True)
ort.disable_telemetry_events()
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
options.log_severity_level = 3
session = ort.InferenceSession(args.model, sess_options=options, providers=['CPUExecutionProvider'])
tts = Kokoro.from_session(session, args.voices)
assert args.voice in tts.voices.files, args.voice

plan = [
    ('falling',0,'tik… tik','tˈɪk',.90),
    ('falling',3,'pit-pat','pˈɪt pˈæt',.90),
    ('flowing',1,'ssss','s',.80),
    ('flowing',2,'fshhhh','fʃ',.50),
    ('flowing',3,'sh-la-sh','ʃlˈɑːʃ',.75),
    ('flowing',4,'shlouuu','ʃlˈuː',.65),
    ('bubbling',1,'bloub','blˈuːb',.85),
    ('bubbling',2,'bloup','blˈuːp',.85),
    ('bubbling',3,'bouloulou','bˈuːluːluː',.80),
    ('mouth',1,'gloup','ɡlˈuːp',.85),
    ('mouth',2,'glo-glo','ɡlˈoʊ ɡlˈoʊ',.85),
    ('mouth',3,'grou-glou','ɡɹˈuː ɡlˈuː',.85)
]

fricative_carriers = {
    # Retain only the naturally articulated consonants from spoken carriers.
    # These explicit crop regions were checked against their spectral envelopes;
    # the model's duration output does not align closely enough for these edits.
    's': ('hˈɪs.', (.800, 1.040)),
    'fʃ': ('ˈɔfʃɔːɹ', (1.115, 1.395)),
}

def render(phonemes, speed):
    carrier, region = fricative_carriers.get(phonemes, (phonemes, None))
    assert tts.tokenizer.known(carrier) == carrier, f'Unsupported phonemes: {carrier}'
    audio, rate = tts.create(carrier, voice=args.voice, speed=speed, lang='en-us',
                             is_phonemes=True, trim=False, sentence_pause=0, clause_pause=0)
    audio = np.asarray(audio, dtype=np.float64).ravel()
    if region:
        audio = audio[round(region[0]*rate):round(region[1]*rate)]
    assert np.all(np.isfinite(audio)) and len(audio)>rate*.05
    # Trim only very quiet outer edges, retaining soft consonants and breath.
    hop = max(1, round(rate*.01))
    rms = np.array([np.sqrt(np.mean(audio[i:i+hop]**2)) for i in range(0,len(audio),hop)])
    active = np.flatnonzero(rms>max(float(np.max(rms))*.015, .00001))
    assert len(active), f'Silent generation: {phonemes}'
    start = max(0,int(active[0]*hop)-round(rate*.04))
    end = min(len(audio),int((active[-1]+1)*hop)+round(rate*.07))
    return audio[start:end], rate

source_id = f'generated-kokoro-{args.voice}-v1'
generated, manifest = [], []
for category, index, text, phonemes, speed in plan:
    started = time.monotonic()
    samples, rate = render(phonemes, speed)
    if text=='tik… tik':
        second, second_rate = render(phonemes,.94)
        assert second_rate==rate
        samples=np.concatenate([samples,np.zeros(round(rate*.50)),second])
    samples=np.concatenate([np.zeros(round(rate*.15)),samples,np.zeros(round(rate*.30))])
    samples-=float(np.mean(samples))
    peak=float(np.max(np.abs(samples)))
    assert peak>.0001, text
    samples*=min(4.0,.72/peak)
    fade=min(round(rate*.005),len(samples)//8)
    samples[:fade]*=np.linspace(0,1,fade)
    samples[-fade:]*=np.linspace(1,0,fade)
    pcm=np.clip(np.rint(samples*32767),-32768,32767).astype('<i2')
    clip_id=f'generated-{category}-{index}'
    path=output/f'{clip_id}.wav'
    with wave.open(str(path),'wb') as audio:
        audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(rate)
        audio.writeframes(pcm.tobytes())
    duration=len(pcm)/rate
    assert .05<=duration<=20, (text,duration)
    clip={"id":clip_id,"kind":"vocal","categoryId":category,"soundIndex":index,"text":text,
          "label":f"Generated voice · {text}","sourceId":source_id,"duration":round(duration,4),
          "mime":"audio/wav","data":base64.b64encode(path.read_bytes()).decode(),
          "provenance":"generated","generator":"Kokoro-82M ONNX","voice":args.voice}
    generated.append(clip)
    metrics={"id":clip_id,"categoryId":category,"soundIndex":index,"text":text,"phonemes":phonemes,
             "speed":speed,"voice":args.voice,"duration":round(duration,4),"sampleRate":rate,
             "rms":round(float(np.sqrt(np.mean(samples**2))),6),"peak":round(float(np.max(np.abs(samples))),6),
             "path":str(path.relative_to(root)),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
    if phonemes in fricative_carriers:
        carrier, region = fricative_carriers[phonemes]
        metrics.update(carrierPhonemes=carrier, retainedSeconds=list(region))
    manifest.append(metrics)
    print(f"Generated {text}: {duration:.2f}s ({time.monotonic()-started:.1f}s processing)",flush=True)

bank_path=root/'vocal-bank.json'
bank=json.loads(bank_path.read_text())
replaced={(clip['categoryId'],clip['soundIndex']) for clip in generated}
bank['clips']=[clip for clip in bank['clips'] if (clip['categoryId'],clip['soundIndex']) not in replaced]+generated
bank['sources']=[source for source in bank['sources'] if source['id']!=source_id]+[{
    "id":source_id,"title":f"Generated onomatopoeias · {args.voice}",
    "author":"AI-generated locally with Kokoro-82M",
    "license":"Generated voice takes · model Apache-2.0",
    "url":"https://huggingface.co/hexgrad/Kokoro-82M",
    "modelUrl":"https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1"}]
bank_path.write_text(json.dumps(bank,ensure_ascii=False,separators=(',',':')))
summary={"generator":"Kokoro-82M ONNX","runtimeVersion":importlib.metadata.version('kokoro-onnx'),
         "voice":args.voice,"modelSha256":hashlib.sha256(Path(args.model).read_bytes()).hexdigest(),
         "voicesSha256":hashlib.sha256(Path(args.voices).read_bytes()).hexdigest(),
         "source":"https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1",
         "takes":manifest}
(root/'generated-vocals-manifest.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(f"Ready: {len(bank['clips'])}/20 vocal sounds; {len(generated)} generated takes embedded.",flush=True)
