"""Immutable local candidate builder. Does not install or enable WhiteCap assets."""
import argparse
import hashlib
import importlib.metadata
import json
import os
import re
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from masks import detect, SIZE, VERSION, PARAMETERS, NAMES, GAINS

HERE = Path(__file__).resolve().parent
APP = HERE.parents[2]
DATA = APP/'data/nasa-whitecap'
LIB = DATA/'library'
OUTPUT = DATA/'mask-candidates'

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def unlinked(path):
    for p in (path, *path.parents):
        if p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction()):
            raise ValueError('Linked path not allowed')
        if p.is_file() and p.stat().st_nlink>1:
            raise ValueError('Hard-linked file not allowed')

def eligible(entry):
    # No semantic detector claims: start with nebula/star-forming scenes only.
    # Titles are local provenance metadata, never commands or path components.
    text=(entry.get('title','')+' '+entry.get('target','')).lower()
    if re.search(r'galax|deep field|planet(?!ary)|\bjupiter\b|\bsaturn\b', text):
        return False, 'scene_outside_validated_nebula_scope'
    if not re.search(r'nebula|cliffs|pillars|rho ophiuchi|serpens|ngc (?:7129|604|346)',text):
        return False, 'unclassified_scene_requires_review'
    return True, None

def environment():
    # Fail rather than silently changing results after an environment update.
    expected={}
    for line in (HERE/'requirements.txt').read_text(encoding='utf-8').splitlines():
        if line and not line.startswith('#'):
            name,version=line.split('==');expected[name]=version
    actual={name:importlib.metadata.version(name) for name in expected}
    if actual!=expected: raise ValueError('Preprocessing dependency versions differ from lock')
    return actual

def verify_cache(directory, key, source_hash):
    unlinked(directory)
    unlinked(directory/'candidate.json')
    report=json.loads((directory/'candidate.json').read_text(encoding='utf-8'))
    if report.get('cacheKey')!=key or report.get('sourceSha256')!=source_hash:
        raise ValueError('Candidate cache identity mismatch')
    if report.get('schema')!=1 or report.get('enabled') is not False or report.get('status') not in ('candidate','static'):
        raise ValueError('Invalid candidate cache state')
    expected={'detections.jpg','original-preview.png','maximum-preview.png','masks.jpg'}
    if report['status']=='candidate':
        expected|={n+'-alpha.png' for n in NAMES}|{'reactive-'+n+'.png' for n in NAMES}
    if set(report['files'])!=expected: raise ValueError('Candidate cache members missing or unexpected')
    for name,sha in report['files'].items():
        if not re.fullmatch(r'[a-z0-9-]+\.(?:png|jpg)', name): raise ValueError('Invalid cache member')
        p=directory/name;unlinked(p)
        if digest(p)!=sha: raise ValueError('Candidate cache hash mismatch; preserve for inspection')
    return report

def build(image_id):
    if not re.fullmatch(r'nasa-science-\d+',image_id): raise ValueError('Invalid local NASA image id')
    unlinked(LIB/'library.json')
    entries=json.loads((LIB/'library.json').read_text(encoding='utf-8'))['entries']
    entry=next((e for e in entries if e['id']==image_id),None)
    if not entry or not re.fullmatch(r'[a-f0-9]{64}\.jpg',entry['file']): raise ValueError('Cached image missing')
    source=LIB/entry['file'];unlinked(source)
    if source.stat().st_size>32*1024*1024: raise ValueError('Image exceeds source size budget')
    source_hash=digest(source)
    if source_hash!=entry['sha256']: raise ValueError('NASA source hash mismatch')
    env=environment()
    identity=dict(version=VERSION,parameters=PARAMETERS,source=source_hash,id=image_id,
                  title=entry['title'],target=entry.get('target',''),dependencies=env,
                  scripts={name:digest(HERE/name) for name in ('masks.py','worker.py','requirements.txt')})
    key=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
    unlinked(OUTPUT);OUTPUT.mkdir(parents=True,exist_ok=True)
    directory=OUTPUT/(image_id+'-'+key[:20])
    if directory.exists(): return verify_cache(directory,key,source_hash),True
    # Bounded storage. Keep prior evidence; refuse rather than silently deleting it.
    members=list(OUTPUT.iterdir())
    if len(members)>=40: raise ValueError('Candidate cache has 40 entries; review/archive old evidence first')
    total=0
    for p in OUTPUT.rglob('*'):
        unlinked(p)
        if p.is_file(): total+=p.stat().st_size
    if total>1024*1024*1024-64*1024*1024: raise ValueError('Candidate cache near 1 GiB limit; review old evidence first')
    staging=OUTPUT/('.pending-'+image_id+'-'+str(os.getpid()))
    staging.mkdir()  # never reuse an interrupted staging directory
    start=time.perf_counter()
    with Image.open(source) as im:
        if im.size!=(3840,2160) or im.mode!='RGB': raise ValueError('Expected prepared 4K RGB JPEG')
        picture=im.resize(SIZE,Image.Resampling.LANCZOS)
    rgb=np.asarray(picture,np.float32)/255
    allowed,reason=eligible(entry)
    if allowed:
        layers,stars,quality=detect(rgb)
    else:
        layers=[np.zeros((SIZE[1],SIZE[0]),np.float32) for _ in NAMES]
        stars=[];quality=dict(status='static',reasons=[reason],rejected={})
    if quality['status']=='static':
        # No usable reactive output for rejected images, even if some points exist.
        layers=[np.zeros_like(layers[0]) for _ in NAMES]
    if any(not np.isfinite(a).all() or a.min()<0 or a.max()>1 for a in layers):
        raise ValueError('Invalid mask')
    if np.max(np.sum(layers,axis=0))>1.00001: raise ValueError('Mask overlap budget exceeded')
    emission=rgb*(1-rgb)
    delta=sum(emission*a[:,:,None]*gain for a,gain in zip(layers,GAINS))
    if float(delta.max())>.03001: raise ValueError('Additive gain budget exceeded')
    # Save layers only for accepted candidates; static reports can never be promoted
    # accidentally by copying a directory of rejected textures.
    if quality['status']=='candidate':
        for name,alpha in zip(NAMES,layers):
            Image.fromarray(np.uint16(alpha*65535)).save(staging/(name+'-alpha.png'))
            Image.fromarray(np.uint8(np.clip(emission*alpha[:,:,None]*255,0,255))).save(staging/('reactive-'+name+'.png'))
    marked=picture.copy();draw=ImageDraw.Draw(marked)
    if quality['status']=='candidate':
        for p in stars:
            x,y=p['x'],p['y'];i=NAMES.index(p['group']);r=(3,6,11)[i]
            draw.ellipse((x-r,y-r,x+r,y+r),outline=('cyan','yellow','magenta')[i],width=1)
    marked.save(staging/'detections.jpg',quality=95)
    picture.save(staging/'original-preview.png')
    Image.fromarray(np.uint8(np.clip(rgb+delta,0,1)*255)).save(staging/'maximum-preview.png')
    # Mask contact sheet is diagnostic, not intended appearance of the effect.
    sheet=Image.new('RGB',(960,580),(16,16,20));d=ImageDraw.Draw(sheet)
    for i,(name,a) in enumerate(zip(NAMES,layers)):
        x,y=(i%2)*480,(i//2)*290
        d.text((x+8,y+6),name+' alpha',fill='white')
        sheet.paste(Image.fromarray(np.uint8(a*255)).convert('RGB').resize((480,270)),(x,y+20))
    sheet.save(staging/'masks.jpg',quality=95)
    report=dict(schema=1,version=VERSION,imageId=image_id,title=entry['title'],sourceSha256=source_hash,
                cacheKey=key,identity=identity,status=quality['status'],quality=quality,
                enabled=False,reviewRequired=True,reviewStatus='pending' if quality['status']=='candidate' else 'static',
                dimensions=list(SIZE),stars=stars,
                groups={n:sum(p['group']==n for p in stars) for n in NAMES[:3]},
                maxDelta8bit=float(delta.max()*255),meanDelta8bit=float(delta.mean()*255),
                elapsedSeconds=time.perf_counter()-start,
                files={p.name:digest(p) for p in staging.iterdir() if p.is_file()},
                note='Offline candidate only. No installation or automatic ingestion. Preview is maximum synthetic envelope, not live audio.')
    if sum(p.stat().st_size for p in staging.iterdir())>64*1024*1024: raise ValueError('Candidate output exceeds 64 MiB')
    if digest(source)!=source_hash: raise ValueError('Source changed during preparation')
    (staging/'candidate.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    staging.rename(directory)
    return report,False

def main():
    parser=argparse.ArgumentParser();parser.add_argument('image_id');args=parser.parse_args()
    report,cached=build(args.image_id)
    print(json.dumps({k:report[k] for k in ('imageId','cacheKey','status','groups','elapsedSeconds','quality')}
                     |dict(cached=cached,enabled=False)))

if __name__=='__main__': main()
