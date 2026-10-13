"""Explicitly curated, source-bound masks; no unattended scene admission."""
import argparse
import json
import math
import hashlib
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from masks import detect, blur, SIZE, NAMES, GAINS
from worker import LIB, DATA, HERE, digest, unlinked, environment

OUT = DATA/'curated-masks'
PROFILES = HERE/'curated-profiles.json'

def source(image_id):
    import re
    if not re.fullmatch(r'nasa-science-\d+',image_id): raise ValueError('Invalid image ID')
    entry=next(e for e in json.loads((LIB/'library.json').read_text())['entries'] if e['id']==image_id)
    if not re.fullmatch(r'[a-f0-9]{64}\.jpg',entry['file']): raise ValueError('Invalid source name')
    file=LIB/entry['file'];unlinked(file)
    if digest(file)!=entry['sha256']: raise ValueError('Source changed')
    with Image.open(file) as im:
        if im.size!=(3840,2160) or im.mode!='RGB': raise ValueError('Expected original 4K RGB')
        picture=im.resize(SIZE,Image.Resampling.LANCZOS)
    return entry,picture,np.asarray(picture,np.float32)/255

def scanned(image_id):
    entry,picture,rgb=source(image_id)
    _,stars,quality=detect(rgb)
    # A manually reviewed shortlist, never an automatic approval of detector output.
    stars=sorted(stars,key=lambda p:p['flux'],reverse=True)[:32]
    return entry,picture,rgb,stars,quality

def scan(image_id):
    environment();entry,picture,rgb,stars,quality=scanned(image_id)
    directory=OUT/'inspection';unlinked(directory);directory.mkdir(parents=True,exist_ok=True)
    marked=picture.copy();d=ImageDraw.Draw(marked)
    font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',21)
    for i,p in enumerate(stars):
        x,y=p['x'],p['y'];d.ellipse((x-11,y-11,x+11,y+11),outline='cyan',width=2)
        d.text((x+12,y-12),str(i),font=font,fill='white',stroke_width=2,stroke_fill='black')
    marked.save(directory/(image_id+'.jpg'),quality=94)
    (directory/(image_id+'.json')).write_text(json.dumps(dict(imageId=image_id,sourceSha256=entry['sha256'],stars=stars,quality=quality),indent=2))
    return dict(imageId=image_id,points=len(stars),quality=quality.get('status'))

def layers_for(rgb,stars,regions):
    """Stationary star cores + feathered, hand-selected broad luminous regions."""
    cv2.setNumThreads(2)
    lum=rgb @ np.array([.2126,.7152,.0722],np.float32)
    h,w=lum.shape; yy,xx=np.mgrid[:h,:w]
    masks=[np.zeros_like(lum) for _ in range(3)]
    exclude=np.zeros_like(lum,dtype=np.uint8)
    for p in stars:
        sigma=float(np.clip(p['diameter']/2.355,1,6))
        if p['group']=='large': sigma=min(7,sigma*1.15)
        x,y=p['x'],p['y'];r=math.ceil(sigma*4)
        x0,x1=max(0,x-r),min(w,x+r+1);y0,y1=max(0,y-r),min(h,y+r+1)
        spot=np.exp(-((xx[y0:y1,x0:x1]-x)**2+(yy[y0:y1,x0:x1]-y)**2)/(2*sigma*sigma))
        layer=masks[NAMES.index(p['group'])];layer[y0:y1,x0:x1]=np.maximum(layer[y0:y1,x0:x1],spot)
        cv2.circle(exclude,(x,y),math.ceil(sigma*4),255,-1)
    # Suppress all sharp peaks in the broad mask, including unselected stars.
    local=cv2.morphologyEx(lum,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15)))
    filled=cv2.inpaint(local.astype(np.float32),exclude,5,cv2.INPAINT_NS)
    broad=blur(filled,24)
    support=np.zeros_like(lum)
    for region in regions:
        cx,cy,rx,ry,angle,strength=region
        if not (0<=cx<=1 and 0<=cy<=1 and .01<=rx<=.6 and .01<=ry<=.6 and 0<strength<=.45):
            raise ValueError('Invalid luminous region')
        a=math.radians(angle);dx=xx/w-cx;dy=yy/h-cy
        u=(dx*math.cos(a)+dy*math.sin(a))/rx;v=(-dx*math.sin(a)+dy*math.cos(a))/ry
        # C1-continuous feather. No hard oval boundary or rectangular region.
        t=np.clip((1-np.sqrt(u*u+v*v))/.5,0,1)
        support=np.maximum(support,strength*t*t*(3-2*t))
    cloud=support*np.clip((broad-.07)/.40,0,1)**1.5
    cloud*=np.clip((blur(lum,3)-.035)/.15,0,1)
    cloud*=1-np.clip(blur(np.maximum.reduce(masks),8)*3,0,1)
    # Avoid broad-mask emission on any bright compact structure, even unselected.
    cloud*=1-np.clip((lum-local)/.25,0,1)
    masks.append(cloud)
    boundary=np.clip(cv2.distanceTransform((lum>.02).astype(np.uint8),cv2.DIST_L2,3)/5,0,1)
    total=np.maximum(1,np.sum(masks,axis=0))
    return [np.clip(m/total*boundary,0,1).astype(np.float32) for m in masks]

def build(image_id):
    deps=environment();entry,picture,rgb,found,quality=scanned(image_id)
    profile=json.loads(PROFILES.read_text())[image_id]
    if profile['sourceSha256']!=entry['sha256']: raise ValueError('Profile requires new source review')
    chosen=[]
    for xy in profile['stars']:
        p=next((p for p in found if [p['x'],p['y']]==xy),None)
        if p is None: raise ValueError('Reviewed star no longer matches detector')
        chosen.append(p)
    if len(chosen)>32 or len({(p['x'],p['y']) for p in chosen})!=len(chosen): raise ValueError('Invalid shortlist')
    masks=layers_for(rgb,chosen,profile['regions'])
    if not any(float(m.max())>.005 for m in masks): raise ValueError('No trustworthy reactive region; keep static')
    identity=dict(profile=profile,source=entry['sha256'],dependencies=deps,
                  scripts={n:digest(HERE/n) for n in ('curated.py','masks.py','requirements.txt')})
    key=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
    folder=OUT/(image_id+'-'+key[:20]);unlinked(OUT);unlinked(folder);OUT.mkdir(exist_ok=True)
    if folder.exists():
        r=json.loads((folder/'candidate.json').read_text())
        if r['key']!=key: raise ValueError('Cache identity mismatch')
        for name,h in r['files'].items():
            if Path(name).name!=name: raise ValueError('Invalid member')
            unlinked(folder/name)
            if digest(folder/name)!=h: raise ValueError('Cached mask changed')
        return dict(imageId=image_id,key=key,groups=r['groups'],cached=True)
    if len(list(OUT.iterdir()))>=64 or sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file())>1024**3:
        raise ValueError('Curated cache limit; inspect/archive generations')
    stage=OUT/('.pending-'+image_id);unlinked(stage);stage.mkdir()
    delta=sum(rgb*(1-rgb)*m[:,:,None]*g for m,g in zip(masks,GAINS))
    if not np.isfinite(delta).all() or delta.max()>.03001: raise ValueError('Invalid emission budget')
    for name,m in zip(NAMES,masks):
        Image.fromarray(np.uint8(rgb*(1-rgb)*m[:,:,None]*255)).save(stage/('reactive-'+name+'.png'))
    picture.save(stage/'original.jpg',quality=94)
    Image.fromarray(np.uint8(np.clip(rgb+delta,0,1)*255)).save(stage/'maximum.jpg',quality=94)
    sheet=Image.new('RGB',(960,580),(12,12,16));d=ImageDraw.Draw(sheet)
    for i,(name,m) in enumerate(zip(NAMES,masks)):
        x,y=i%2*480,i//2*290;sheet.paste(Image.fromarray(np.uint8(m*255)).convert('RGB').resize((480,270)),(x,y+20));d.text((x+8,y+4),name,fill='white')
    sheet.save(stage/'masks.jpg',quality=95)
    marked=picture.copy();d=ImageDraw.Draw(marked)
    for p in chosen:
        x,y=p['x'],p['y'];d.ellipse((x-9,y-9,x+9,y+9),outline={'small':'cyan','medium':'yellow','large':'magenta'}[p['group']],width=2)
    marked.save(stage/'detections.jpg',quality=95)
    report=dict(version=1,imageId=image_id,key=key,sourceSha256=entry['sha256'],identity=identity,
                enabled=False,reviewRequired=True,stars=chosen,regions=profile['regions'],reason=profile['reason'],
                groups={n:sum(p['group']==n for p in chosen) for n in NAMES[:3]},
                cloudMean=float(masks[3].mean()),maxDelta8bit=float(delta.max()*255),
                files={p.name:digest(p) for p in stage.iterdir()})
    (stage/'candidate.json').write_text(json.dumps(report,indent=2)+'\n')
    if digest(LIB/entry['file'])!=entry['sha256']: raise ValueError('Source changed during work')
    stage.rename(folder)
    return dict(imageId=image_id,key=key,groups=report['groups'],cached=False)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('image_id');p.add_argument('--scan',action='store_true');a=p.parse_args()
    print(json.dumps(scan(a.image_id) if a.scan else build(a.image_id)))
