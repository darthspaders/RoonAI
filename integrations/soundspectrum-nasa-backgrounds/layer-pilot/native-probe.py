# Temporary native probe; installed only while its owning test session runs.
import math, time, sys, traceback
from SSEngine import EngineInstance
PLAN = __PLAN__
LOG = __LOG__
MODE = __MODE__

def record(event, **values):
    values.update(event=event,at=time.time())
    with open(LOG,'a') as stream: stream.write(repr(values)+'\n')

def ExportPackage(inPathname):
    pkg=VisPackage(inPathname)
    pkg.DefaultEntryConfigType='Background'
    for target in PLAN:
        if target.get('script'): pkg.AddEntry(target['name'].encode('utf-8'),target['script'].encode('utf-8'))
    original=EngineInstance.RenderFrame
    state={'start':None,'index':-1,'selectedAt':0,'sampleAt':0,'reported':False,'done':False,'last':None,'times':[],'gaps':[]}
    def render(engine,at):
        now=time.time()
        try:
            if state['start'] is None:
                state['start']=now
                record('start',python=sys.version,mode=MODE)
                engine.SetSlideshowEnabled('Background',False)
            art=getattr(engine,'_rh_whitecap_artwork_v1',None)
            if art: art['next']=engine.mTimeIndex+180
            elapsed=now-state['start']
            if state['done']: return original(engine,at)
            if elapsed>135: raise RuntimeError('Pilot probe exceeded deadline')
            if elapsed<10: return original(engine,at)
            age=now-state['selectedAt']
            if state['index']<0 or age>=20:
                if state['index']>=0 and not state['reported']: raise RuntimeError('Scene did not complete')
                state['index']+=1
                if state['index']>=len(PLAN):
                    state['done']=True;record('complete',scenes=len(PLAN));return original(engine,at)
                target=PLAN[state['index']]
                engine.StartConfig('Background',target['name'].encode('utf-8'),2.0)
                if art: art['last']=target['name']
                state.update(selectedAt=now,sampleAt=0,reported=False,last=None,times=[],gaps=[])
                record('selected',id=target['id'])
                return original(engine,at)
            target=PLAN[state['index']]
            selected=[]
            for scene in engine.GetRunningConfigGroup('Background').mInstanceList:
                if scene.mTitle==target['name']:
                    for layer in scene.mSceneLayers or []:
                        if hasattr(layer,'levels'): selected.append(layer)
            for layer in selected:
                if not hasattr(layer,'_pilot_original_draw'):
                    layer._pilot_original_draw=layer.Draw
                    def draw(t,dt,audio,layer=layer):
                        age=time.time()-state['selectedAt']
                        if age<4 or (MODE=='controlled' and age>=15):
                            audio=[0.0]*len(audio)
                            if age<4: layer.levels=[0.0]*len(layer.levels)
                        elif MODE=='controlled':
                            pulse=.075+.15*(.5+.5*math.sin(age*6.28))**4
                            audio=[pulse if i<len(audio)*.23 else pulse*.7 for i in range(len(audio))]
                        started=time.clock()
                        result=layer._pilot_original_draw(t,dt,audio)
                        if 5<age<14: state['times'].append((time.clock()-started)*1000)
                        return result
                    layer.Draw=draw
            result=original(engine,at)
            if state['last'] is not None and 5<age<14: state['gaps'].append((now-state['last'])*1000)
            state['last']=now
            for layer in selected:
                # Last five seconds are inspection frames without foreground;
                # timing samples above exclude this additional draw.
                if age>=15:
                    layer._pilot_original_draw(engine.mTimeIndex,0,engine.mAudioData)
                if now-state['sampleAt']>1 and age>2:
                    state['sampleAt']=now
                    record('sample',id=target['id'],age=age,levels=list(layer.levels),displacement=getattr(layer,'displacement',None),
                        ready=getattr(layer,'ready',None),imageId=getattr(layer,'image_id',None),audioMax=max([abs(float(x)) for x in engine.mAudioData] or [0]),isolated=age>=15)
                if age>18 and not state['reported']:
                    if target.get('script') and (not layer.ready or layer.image_id!=target['id'] or bool(layer.cloud)!=target['cloud']): raise RuntimeError('Pilot texture or per-entry state failed')
                    if len(state['times'])<30: raise RuntimeError('Insufficient native timing samples')
                    record('rendered',id=target['id'],drawMilliseconds=state['times'],frameGapsMilliseconds=state['gaps'])
                    state['reported']=True
            return result
        except Exception:
            record('error',detail=traceback.format_exc());state['done']=True;raise
    EngineInstance.RenderFrame=render
    return pkg
