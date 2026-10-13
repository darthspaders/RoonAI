"""Small, artistic diffraction glow sprite. No source photograph is edited.

Only coordinates already admitted by the source-bound masks can receive one.
This is a visualizer embellishment, not an astronomical reconstruction.
"""
import json, math, sys
from pathlib import Path
import numpy as np
from PIL import Image

def sprite():
    yy,xx=np.mgrid[:192,:192].astype(np.float32);xx=(xx-95.5)/95.5;yy=(yy-95.5)/95.5
    radius=np.hypot(xx,yy);light=np.zeros_like(radius)
    for angle,strength in [(math.pi/6,1),(math.pi/2,1),(5*math.pi/6,1),(0,.38)]:
        along=xx*math.cos(angle)+yy*math.sin(angle)
        across=-xx*math.sin(angle)+yy*math.cos(angle)
        ray=np.exp(-(across/.016)**2)*np.exp(-abs(along)*3.3)*strength
        light=np.maximum(light,ray)
    light+=.16*np.exp(-(radius/.16)**2)
    light*=np.clip((1-radius)/.25,0,1)**2
    return np.repeat(np.uint8(np.clip(light,0,1)*255)[:,:,None],3,axis=2)

def build(input_path,folder):
    data=json.loads(Path(input_path).read_text(encoding='utf8'));folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    with Image.open(data['source']) as image: rgb=np.asarray(image.convert('RGB').resize((1920,1080)),np.float32)/255
    chosen=sorted(data['stars'],key=lambda s:s['flux'],reverse=True)[:12]
    selected=[]
    for i,p in enumerate(chosen):
        x,y=p['x'],p['y']
        if not (0<=x<1920 and 0<=y<1080): raise ValueError('Flare outside source')
        color=np.maximum(.65,rgb[y,x]);color=(color/max(color)).tolist()
        radius=float(np.clip(p['diameter']*5,18,74))
        selected.append([x/1920,y/1080,radius/1920,{'small':0,'medium':1,'large':2}[p['group']],i*2.39996323,*color])
    flare=sprite();Image.fromarray(flare).save(folder/'flare.png')
    # Simulated maximum-envelope preview, clearly separate from live GPU proof.
    preview=rgb.copy()
    for x,y,r,channel,phase,*color in selected:
        size=round(r*1920*2*1.42);tile=np.asarray(Image.fromarray(flare).resize((size,size)),np.float32)/255
        x0,y0=round(x*1920-size/2),round(y*1080-size/2)
        left,top,right,bottom=max(0,x0),max(0,y0),min(1920,x0+size),min(1080,y0+size)
        preview[top:bottom,left:right]+=tile[top-y0:bottom-y0,left-x0:right-x0]*np.array(color)*.22
    Image.fromarray(np.uint8(np.clip(preview,0,1)*255)).save(folder/'preview.jpg',quality=94)
    (folder/'flares.json').write_text(json.dumps(dict(version=1,sourceSha256=data['sourceSha256'],stars=selected),indent=2)+'\n')
    print(json.dumps(dict(stars=len(selected))))

if __name__=='__main__': build(sys.argv[1],sys.argv[2])
