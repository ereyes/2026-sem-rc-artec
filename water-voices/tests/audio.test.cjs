const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({ deferred = false, vocalCount = 2 } = {}) {
  let clock = 0, nextTimer = 1, contextCount = 0, starts = 0, resumeCalls = 0;
  const timers = new Map(), pendingDecodes = [], states = [], events = [];
  function schedule(fn, delay) { const id = nextTimer++; timers.set(id, { at:clock+delay, fn }); return id; }
  function clear(id) { timers.delete(id); }
  const parameter = () => ({ value:0, setValueAtTime(v){this.value=v;}, linearRampToValueAtTime(v){this.value=v;}, setTargetAtTime(v){this.value=v;}, cancelScheduledValues(){} });
  const node = () => ({ connect(){}, disconnect(){}, gain:parameter(), pan:parameter() });
  class Context {
    constructor() { contextCount++; this.state='suspended'; this.destination={}; }
    get currentTime() { return clock/1000; }
    resume() { resumeCalls++; this.state='running'; return Promise.resolve(); }
    createGain() { return node(); }
    createStereoPanner() { return node(); }
    createDynamicsCompressor() { return { ...node(), threshold:parameter(), knee:parameter(), ratio:parameter(), attack:parameter(), release:parameter() }; }
    decodeAudioData() {
      if (deferred) return new Promise(resolve => pendingDecodes.push(() => resolve({ duration:.4 })));
      return Promise.resolve({ duration:.4 });
    }
    createBufferSource() {
      let endTimer;
      const source = { ...node(), playbackRate:parameter(), onended:null,
        start(at) { starts++; endTimer=schedule(() => source.onended?.(), Math.max(0,at*1000-clock)+400/source.playbackRate.value); },
        stop(at=clock/1000) { clear(endTimer); endTimer=schedule(() => source.onended?.(), Math.max(0,at*1000-clock)); }
      };
      return source;
    }
    close() { this.state='closed'; return Promise.resolve(); }
  }
  const window = { AudioContext:Context, setTimeout:schedule, clearTimeout:clear, atob:s=>Buffer.from(s,'base64').toString('binary') };
  const math = Object.create(Math); math.random=()=>.05;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../audio.js'),'utf8'), { window, Math:math, Uint8Array, Promise, Map, Set, Number, String, Array });
  const clips = [];
  for (const categoryId of ['falling','flowing','bubbling','mouth']) {
    clips.push({id:`${categoryId}-legacy-fx`,categoryId,soundIndex:4,data:'AA=='});
    for(let index=0;index<vocalCount;index++) clips.push({id:`${categoryId}-vocal-${index}`,categoryId,kind:'vocal',soundIndex:index,data:'AA=='});
    for (const lang of ['en','fr','es','it','de']) clips.push({id:`${categoryId}-${lang}`,categoryId,kind:'word',lang,wordId:`${categoryId}-word-${lang}`,text:lang,data:'AA=='});
  }
  const audio = new window.WaterAudio({bank:{clips},onState:s=>states.push(s),onEvent:e=>events.push(e)});
  async function advance(ms) {
    const target=clock+ms;
    let iterations=0;
    while (true) {
      const next=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!next) break;
      assert.ok(++iterations<10000,'scheduler must remain bounded');
      clock=next[1].at; timers.delete(next[0]); next[1].fn();
      await Promise.resolve();
    }
    clock=target;
  }
  return {audio,states,events,advance,pendingDecodes,get contextCount(){return contextCount;},get starts(){return starts;},get resumeCalls(){return resumeCalls;}};
}

(async () => {
  const h=harness();
  assert.equal(h.contextCount,0,'no audio context or playback before a click');
  const first=h.audio.toggle('falling');
  assert.equal(h.resumeCalls,1,'audio is resumed synchronously from the user action');
  await first;
  await Promise.all(['flowing','bubbling','mouth'].map(id=>h.audio.toggle(id)));
  assert.deepEqual([...h.states.at(-1).activeCategoryIds].sort(),['bubbling','falling','flowing','mouth']);
  await h.advance(6000);
  assert.ok(h.events.some(e=>e.kind==='word'),'recorded words are mixed into vocal takes');
  assert.ok(h.events.some(e=>e.kind==='vocal'),'voiced onomatopoeias remain in the mix');
  assert.ok(!h.events.some(e=>e.clipId?.includes('legacy-fx')),'legacy mouth sound effects are never played');
  h.audio.stop('falling');
  assert.deepEqual([...h.states.at(-1).activeCategoryIds].sort(),['bubbling','flowing','mouth'],'stopping one preserves the other three');
  h.audio.setLanguages(['fr']);
  h.events.length=0;
  await h.advance(10000);
  const words=h.events.filter(e=>e.kind==='word');
  assert.ok(words.length>0,'selected-language words continue to appear');
  assert.ok(words.every(e=>e.lang==='fr'),'future word events respect the live language filter');
  assert.ok(h.events.some(e=>e.kind==='vocal'),'changing languages preserves voiced sound takes');
  const starts=h.starts;
  h.audio.stopAll();
  await h.advance(10000);
  assert.equal(h.starts,starts,'stopping all cancels future playback');
  assert.equal(h.states.at(-1).activeCategoryIds.length,0);
  h.audio.destroy();

  const pending=harness({deferred:true});
  const loading=pending.audio.toggle('mouth');
  await Promise.resolve(); await Promise.resolve();
  pending.audio.stop('mouth');
  pending.pendingDecodes.forEach(resolve=>resolve());
  await loading;
  assert.equal(pending.starts,0,'stopping during decoding prevents a delayed start');
  assert.equal(pending.states.at(-1).activeCategoryIds.length,0);
  pending.audio.destroy();

  const replacement=harness({vocalCount:1});
  await Promise.all(['falling','flowing'].map(id=>replacement.audio.toggle(id)));
  const take={id:'custom-ploc',categoryId:'falling',soundIndex:0,data:'AA==',mime:'audio/wav',text:'ploc'};
  const accepted=await replacement.audio.setVocalTake(take);
  assert.equal(accepted.kind,'vocal');
  assert.equal(accepted.duration,.4,'duration comes from the decoded recording');
  replacement.events.length=0;
  await replacement.advance(4000);
  assert.ok(replacement.events.some(e=>e.clipId==='custom-ploc'),'accepted voice take replaces its sound slot');
  assert.deepEqual([...replacement.states.at(-1).activeCategoryIds].sort(),['falling','flowing'],'replacement preserves concurrent layers');
  await assert.rejects(replacement.audio.setVocalTake({...take,mime:'text/html'}),/audio file/);
  replacement.audio.removeVocalTake('falling',0);
  replacement.events.length=0;
  await replacement.advance(4000);
  assert.ok(replacement.events.some(e=>e.clipId==='falling-vocal-0'),'reset restores the embedded vocal take');
  replacement.audio.destroy();

  const wordsOnly=harness({vocalCount:0});
  await wordsOnly.audio.toggle('bubbling');
  await wordsOnly.advance(3000);
  const played=wordsOnly.events.filter(e=>e.clipId && !e.ended);
  assert.ok(played.length>0 && played.every(e=>e.kind==='word'),'unrecorded sound slots use only spoken words, never legacy effects');
  wordsOnly.audio.destroy();
  console.log('PASS: no autoplay; four layers; independent stops; word/language mixing; legacy FX excluded; live vocal replacement/reset; words-only fallback; stop-all cleanup; decode cancellation.');
})().catch(error=>{ console.error(error); process.exitCode=1; });
