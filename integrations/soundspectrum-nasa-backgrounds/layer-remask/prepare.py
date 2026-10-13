"""Second-generation candidates. Originals and first pilot remain immutable."""
import importlib.util, json, pathlib, shutil, sys
import cv2
import numpy as np
from PIL import Image

HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('pilot',HERE.parent/'layer-pilot/prepare.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
WORK=p.ROOT/'data/nasa-whitecap/layer-remask-v2'
PLAN=json.loads((WORK/'plan.json').read_text(encoding='utf8'))

def source(image_id):
    cfg=next(e for e in PLAN['images'] if e['id']==image_id).copy()
    e=next(e for e in json.loads((p.LIB/'library.json').read_text(encoding='utf8'))['entries'] if e['id']==image_id)
    file=p.LIB/e['file']
    if e['sha256']!=cfg['sha256'] or e['file']!=cfg['sha256']+'.jpg' or file.is_symlink() or p.digest(file)!=cfg['sha256']: raise ValueError('Changed remask source')
    rgb=np.array(Image.open(file).convert('RGB'))
    if rgb.shape!=(2160,3840,3): raise ValueError('Remask requires unchanged 4K source')
    folder=WORK/(image_id+'-'+cfg['sha256'][:12]);folder.mkdir(exist_ok=True)
    live=rgb.max(2)>8
    xs=np.flatnonzero(live.mean(0)>.15);ys=np.flatnonzero(live.mean(1)>.15)
    if not len(xs) or not len(ys): raise ValueError('No image content')
    box=[int(xs[0]),int(ys[0]),int(xs[-1]+1),int(ys[-1]+1)]
    return cfg,e,rgb,folder,box

p.source=source
original_sam=p.run_sam
def sam(rgb,cfg,folder):
    key={'sourceSha256':cfg['sha256'],'recipe':'cloud-seeds-v2','points':cfg.get('points',[]),'labels':cfg.get('labels',[])}
    checked=folder/'sam-validated.json'
    if checked.exists():
        old=json.loads(checked.read_text())
        if old.get('key')==key and old.get('maskSha256')==p.digest(folder/'sam-mask.png'):
            return np.array(Image.open(folder/'sam-mask.png'))
    if not cfg.get('points'):
        # Seed proposals only: SAM masks still require visual review before use.
        # Metadata has already limited this branch to cloud subjects.
        small=cv2.resize(rgb,(256,256)).astype('float32')/255
        smooth=cv2.GaussianBlur(small,(0,0),5)
        lum=cv2.cvtColor(smooth,cv2.COLOR_RGB2GRAY)
        score=lum*(.25+smooth.max(2)-smooth.min(2))
        score[:20]=0;score[-20:]=0;score[:,:20]=0;score[:,-20:]=0
        positive=[];working=score.copy()
        for _ in range(3):
            y,x=np.unravel_index(working.argmax(),working.shape)
            if working[y,x]<.04: break
            positive.append([float(x)/256,float(y)/256])
            cv2.circle(working,(int(x),int(y)),48,0,-1)
        if not positive: raise ValueError('No credible diffuse-cloud seed; flares retained')
        candidates=[[.08,.08],[.5,.08],[.92,.08],[.08,.92],[.5,.92],[.92,.92]]
        negative=[xy for xy in candidates if lum[int(xy[1]*256),int(xy[0]*256)]<np.percentile(lum,30)]
        cfg['points']=positive+negative;cfg['labels']=[1]*len(positive)+[0]*len(negative)
    mask=original_sam(rgb,cfg,folder)
    receipt=json.loads((folder/'sam.json').read_text())
    if not cfg.get('reviewedPoints') and (max(receipt['scores'])<.8 or not .025<float(mask.mean()/255)<.85):
        raise ValueError('Automatic cloud segmentation failed confidence/coverage gate; candidate preserved')
    p.json_write(checked,{'key':key,'maskSha256':p.digest(folder/'sam-mask.png')})
    return mask
p.run_sam=sam

def analyze(image_id):
    cfg,e,rgb,folder,box=source(image_id)
    if not cfg['cloud']:
        # Remask every image's bright anchors, but don't invent gas in deep fields.
        sys.path.insert(0,str(HERE.parent/'preprocessing'))
        from expressive import prepare
        receipt=prepare(p.LIB/e['file'],folder/'flares.json')
        p.json_write(folder/'candidate.json',dict(version=2,imageId=image_id,sourceSha256=cfg['sha256'],cloud=False,
            status='flares-only',reason='No supported cloud subject; fixed photograph and stellar flares',
            stars=len(receipt['stars']),files={'flares.json':p.digest(folder/'flares.json')},review='not-required',enabled=False))
        return
    p.analyze(image_id)
    r=json.loads((folder/'candidate.json').read_text())
    if r['neutralMaxError']!=0: raise ValueError('Remask neutral reconstruction mismatch')
    r.update(version=2,status='candidate',interiorOnly=True,review='pending',recipe='separated-cloud-interior-v2')
    p.json_write(folder/'candidate.json',r)

if __name__=='__main__':
    if sys.argv[1]=='input': p.input_stage(sys.argv[2])
    elif sys.argv[1]=='segment':
        import torch
        torch.set_num_threads(4);torch.set_num_interop_threads(2)
        cfg,e,rgb,folder,box=source(sys.argv[2]);x0,y0,x1,y1=box
        sam(rgb[y0:y1,x0:x1],cfg,folder)
    elif sys.argv[1]=='analyze': analyze(sys.argv[2])
    elif sys.argv[1]=='flares':
        for cfg in PLAN['images']:
            if not cfg['cloud']:
                try:
                    folder=WORK/(cfg['id']+'-'+cfg['sha256'][:12])
                    r=json.loads((folder/'candidate.json').read_text()) if (folder/'candidate.json').exists() else {}
                    if r.get('sourceSha256')==cfg['sha256'] and r.get('status')=='flares-only' and r.get('files',{}).get('flares.json')==p.digest(folder/'flares.json') and p.digest(p.LIB/(cfg['sha256']+'.jpg'))==cfg['sha256']: continue
                    analyze(cfg['id'])
                except Exception as error: print(json.dumps({'id':cfg['id'],'failed':str(error)}),flush=True)
    else: raise ValueError('Unknown remask stage')
