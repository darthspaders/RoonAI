"""Diffuse light flow from an EXISTING reviewed cloud emission layer.

No ingestion, segmentation approval or photograph write. Blur removes compact
stellar detail from the emission, then native rendering moves this low-frequency
light only. Moving the actual photograph would also displace embedded stars.
"""
import hashlib, json, sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

COLS, ROWS = 33, 19

def prepare_light(rgb, emission):
    h,w,_ = rgb.shape
    light = cv2.GaussianBlur(emission,(0,0),10)
    # Remain within existing support; keep a moat around black fitted margins.
    support=cv2.GaussianBlur(emission.max(2),(0,0),16)
    light*=np.clip(support/.008,0,1)[:,:,None]
    photo=(rgb.max(2)>.015).astype(np.uint8)
    margin=cv2.distanceTransform(photo,cv2.DIST_L2,3)
    edge=np.minimum.reduce(np.broadcast_arrays(np.arange(w)[None,:],(w-1-np.arange(w))[None,:],np.arange(h)[:,None],(h-1-np.arange(h))[:,None]))
    safe=np.clip((np.minimum(margin,edge)-26)/24,0,1)
    light*=safe[:,:,None]
    light=np.minimum(light,.16)  # bounded low-frequency emission, never white wash
    xs=np.linspace(0,w-1,COLS).round().astype(int)
    ys=np.linspace(0,h-1,ROWS).round().astype(int)
    weights=np.clip(support[np.ix_(ys,xs)]*24,0,.92)
    weights[[0,-1],:]=0;weights[:,[0,-1]]=0
    if light.max()<.004:weights[:]=0
    return light,weights

def build(input_file, output):
    data=json.loads(Path(input_file).read_text(encoding='utf8'))
    for name,key in [('source','sourceSha256'),('emission','emissionSha256')]:
        if hashlib.sha256(Path(data[name]).read_bytes()).hexdigest()!=data[key]:
            raise ValueError('Source-bound cloud input changed')
    with Image.open(data['source']) as im:
        if im.size!=(3840,2160): raise ValueError('Expected 4K presentation')
        picture=im.convert('RGB').resize((1920,1080),Image.Resampling.LANCZOS)
    with Image.open(data['emission']) as im:
        if im.size!=(1920,1080): raise ValueError('Expected reviewed cloud layer')
        emission=np.asarray(im.convert('RGB'),np.float32)/255
    rgb=np.asarray(picture,np.float32)/255
    light,weights=prepare_light(rgb,emission)
    light_path=Path(output).with_name('cloud-flow.png')
    Image.fromarray(np.uint8(np.clip(light,0,1)*255)).save(light_path)
    result=dict(version=1,sourceSha256=data['sourceSha256'],emissionSha256=data['emissionSha256'],
                grid=[COLS,ROWS,[round(float(v),4) for v in weights.flatten()]],activeVertices=int(np.count_nonzero(weights)),
                fileSha256=hashlib.sha256(light_path.read_bytes()).hexdigest(),maxEmission=float(light.max()))
    Path(output).write_text(json.dumps(result)+'\n',encoding='utf8')
    print(json.dumps(dict(activeVertices=result['activeVertices'])))

if __name__=='__main__':
    cv2.setNumThreads(2)
    build(sys.argv[1],sys.argv[2])
