"""Source-bound artistic feature maps. No network, audio, or source edits."""
import sys, json, hashlib, os
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from flares import sprite

VERSION = 'expressive-1'

def prepare(source, output):
    source, output = Path(source), Path(output)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    with Image.open(source) as im:
        if im.size != (3840, 2160): raise ValueError('expressive_requires_prepared_4k')
        rgb = np.asarray(im.convert('RGB').resize((960,540)), np.float32)/255
    lum = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    smooth = cv2.GaussianBlur(lum,(0,0),10)
    # Bright compact features are artistic anchors, not astronomical labels.
    residual = lum-cv2.GaussianBlur(lum,(0,0),3)
    peaks = (residual == cv2.dilate(residual,np.ones((7,7),np.uint8))) & (residual>.075) & (lum>.34)
    ys,xs=np.nonzero(peaks); candidates=sorted(zip(xs,ys),key=lambda p:float(residual[p[1],p[0]]),reverse=True)
    stars=[]
    for x,y in candidates:
        if min(x,y,959-x,539-y)<15 or any((x-s[0]*960)**2+(y-s[1]*540)**2<24**2 for s in stars): continue
        stars.append([round(float(x)/960,6),round(float(y)/540,6),round(float(np.clip(.012+residual[y,x]*.026,.012,.032)),6),len(stars)*2.39996323])
        if len(stars)>=24: break
    # Smooth luminous structure supplies stronger local deformation. Every image
    # also gets rhythmic field motion; this is deliberately artistic, not AI gas segmentation.
    weights=cv2.resize(np.clip((smooth-.015)*4,0,1),(25,15),interpolation=cv2.INTER_AREA)
    # Protect fitted black borders AND the mesh perimeter from exposed edges.
    content=cv2.resize((lum>.014).astype(np.float32),(25,15),interpolation=cv2.INTER_AREA)
    weights=np.where(content>.45,.30+.70*weights,0)
    weights[[0,-1],:]=0;weights[:,[0,-1]]=0
    result=dict(version=VERSION,sourceSha256=digest,grid=[25,15,np.round(weights,5).flatten().tolist()],stars=stars,
        classification='artistic luminous-feature anchors and diffuse structure; not scientific object segmentation')
    output.parent.mkdir(parents=True,exist_ok=True)
    temporary=output.with_suffix('.tmp')
    temporary.write_text(json.dumps(result)+'\n',encoding='utf8');os.replace(temporary,output)
    return result

if __name__=='__main__':
    cv2.setNumThreads(2)
    if sys.argv[1]=='sprite': Image.fromarray(sprite()).save(sys.argv[2])
    elif sys.argv[1]=='batch':
        library=Path(sys.argv[2]);entries=json.loads((library/'library.json').read_text(encoding='utf8'))['entries']
        destination=library/'expressive';destination.mkdir(exist_ok=True)
        Image.fromarray(sprite()).save(destination/'flare.png')
        for e in entries:
            if e['file']!=e['sha256']+'.jpg' or len(e['sha256'])!=64 or any(c not in '0123456789abcdef' for c in e['sha256']): raise ValueError('invalid_source_identity')
            source=library/e['file'];output=destination/(e['sha256']+'.json')
            if hashlib.sha256(source.read_bytes()).hexdigest()!=e['sha256']: raise ValueError('source_changed')
            if output.exists():
                old=json.loads(output.read_text(encoding='utf8'))
                if old.get('version')==VERSION and old.get('sourceSha256')==e['sha256']: continue
            result=prepare(source,output)
            print(json.dumps(dict(id=e['id'],stars=len(result['stars']))),flush=True)
    else:
        result=prepare(sys.argv[1],sys.argv[2]);print(json.dumps(dict(sourceSha256=result['sourceSha256'],stars=len(result['stars']))))
