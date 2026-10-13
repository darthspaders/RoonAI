"""Offline one-image mask extraction. No network, no processing inside WhiteCap."""
import hashlib, json, math, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

TARGET = 'nasa-science-904703'
NAMES = ('small', 'medium', 'large', 'cloud')
GAINS = (0.12, 0.09, 0.055, 0.045)

def blur(a, radius):
    return np.asarray(Image.fromarray(np.uint8(np.clip(a,0,1)*255)).filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32)/255

def detect(rgb):
    # Display luminance is an artistic feature detector, not astronomical photometry.
    lum = rgb @ np.array([0.2126,0.7152,0.0722], dtype=np.float32)
    smooth = blur(lum, 0.7)
    residual = np.maximum(0, smooth-blur(lum, 14))
    peak = np.asarray(Image.fromarray(np.uint8(smooth*255)).filter(ImageFilter.MaxFilter(11)), dtype=np.float32)/255
    compact = lum-blur(lum,3)
    ys,xs = np.where((smooth >= peak-0.001) & (smooth>0.5) & (residual>0.16)
                     & ((compact>0.13) | (smooth>0.93)))
    # Rank extended flux before capping candidates, so saturated broad stars are
    # not crowded out by hundreds of sharper but much smaller points.
    def score(p):
        x,y=p
        return float(residual[max(0,y-12):y+13,max(0,x-12):x+13].sum())
    ordered = sorted(zip(xs.tolist(),ys.tolist()), key=score, reverse=True)
    chosen=[]
    for x,y in ordered:
        if x<20 or y<20 or x>=lum.shape[1]-20 or y>=lum.shape[0]-20: continue
        # A star is locally bright in most directions. Cloud rims are bright on
        # one side of an edge; reject them instead of making the rim twinkle.
        isolated=False
        for radius in (4,8,12):
            diagonal=max(1,int(radius*0.707))
            offsets=((radius,0),(-radius,0),(0,radius),(0,-radius),
                     (diagonal,diagonal),(diagonal,-diagonal),(-diagonal,diagonal),(-diagonal,-diagonal))
            contrasts=[smooth[y,x]-smooth[y+dy,x+dx] for dx,dy in offsets]
            if sum(v>0.10 for v in contrasts)>=7:
                isolated=True
                break
        if not isolated: continue
        # Curvature must fall away in both axes. Long thin luminous rims can
        # pass a ring test but have almost no curvature along the ridge.
        point_like=False
        for r in (2,4):
            center=smooth[y,x]
            dxx=smooth[y,x+r]+smooth[y,x-r]-2*center
            dyy=smooth[y+r,x]+smooth[y-r,x]-2*center
            dxy=(smooth[y+r,x+r]+smooth[y-r,x-r]-smooth[y+r,x-r]-smooth[y-r,x+r])*0.25
            root=math.sqrt(float((dxx-dyy)**2+4*dxy*dxy))
            minimum,maximum=(dxx+dyy-root)*0.5,(dxx+dyy+root)*0.5
            if maximum < -0.006 and maximum/minimum > 0.2:
                point_like=True
                break
        if not point_like: continue
        if any((x-p['x'])**2+(y-p['y'])**2<18**2 for p in chosen): continue
        patch=residual[y-12:y+13,x-12:x+13]
        # Extended bright cores have larger positive local flux.
        flux=float(patch.sum())
        chosen.append(dict(x=x,y=y,flux=flux,peak=float(lum[y,x])))
        if len(chosen)>=240: break
    ranked=sorted(chosen,key=lambda p:p['flux'],reverse=True)
    masks=[np.zeros(lum.shape,dtype=np.float32) for _ in range(3)]
    for rank,p in enumerate(ranked):
        group=2 if rank<12 else 1 if rank<60 else 0
        sigma=(1.6,3.2,8.0)[group]
        r=int(math.ceil(sigma*3))
        x,y=p['x'],p['y']; x0,x1=max(0,x-r),min(lum.shape[1],x+r+1); y0,y1=max(0,y-r),min(lum.shape[0],y+r+1)
        yy,xx=np.mgrid[y0:y1,x0:x1]
        spot=np.exp(-((xx-x)**2+(yy-y)**2)/(2*sigma*sigma)).astype(np.float32)
        masks[group][y0:y1,x0:x1]=np.maximum(masks[group][y0:y1,x0:x1],spot)
        p['group']=NAMES[group]
    # Broad luminosity only; suppress point sources and protect black padding/dust.
    diffuse=blur(lum,24)
    cloud=np.clip((diffuse-0.14)/0.4,0,1)**1.5
    stars=np.maximum.reduce(masks)
    cloud*=1-np.clip(blur(stars,8)*4,0,1)
    cloud*=np.clip((lum-0.035)/0.15,0,1)
    masks.append(cloud)
    # Normalize overlap so combined response cannot exceed the strongest gain.
    total=np.maximum(1,np.sum(masks,axis=0))
    return [m/total for m in masks], ranked

def prepare(source, out):
    out.mkdir(parents=True,exist_ok=True)
    image=Image.open(source).convert('RGB')
    if image.size!=(3840,2160): raise ValueError('Prototype requires installed 3840x2160 image')
    small=image.resize((1920,1080),Image.Resampling.LANCZOS)
    rgb=np.asarray(small,dtype=np.float32)/255
    masks,stars=detect(rgb)
    # Headroom-weighted original colour; saturated star cores remain intact.
    emission=rgb*(1-rgb)
    files={}
    for name,mask in zip(NAMES,masks):
        file='reactive-'+name+'.png'
        Image.fromarray(np.uint8(np.clip(emission*mask[:,:,None]*255,0,255))).save(out/file,optimize=True)
        files[file]=hashlib.sha256((out/file).read_bytes()).hexdigest()
    review=small.copy(); draw=ImageDraw.Draw(review)
    for p in stars:
        r={'small':3,'medium':6,'large':11}[p['group']]
        color={'small':'cyan','medium':'yellow','large':'magenta'}[p['group']]
        draw.ellipse((p['x']-r,p['y']-r,p['x']+r,p['y']+r),outline=color,width=1)
    review.save(out/'detections.jpg',quality=94)
    Image.fromarray(np.uint8(masks[3]*255)).save(out/'cloud-mask.png')
    delta=sum(emission*m[:,:,None]*g for m,g in zip(masks,GAINS))
    boosted=Image.fromarray(np.uint8(np.clip(rgb+delta,0,1)*255))
    small.save(out/'original-preview.png'); boosted.save(out/'maximum-preview.png')
    # Deliberately slow offline envelope demonstration, NOT a live-audio recording.
    frames=[]
    for n in range(40):
        amount=(1-math.cos(2*math.pi*n/40))*0.5
        frames.append(Image.fromarray(np.uint8(np.clip(rgb+delta*amount,0,1)*255)).resize((960,540)))
    frames[0].save(out/'envelope-preview.webp',save_all=True,append_images=frames[1:],duration=125,loop=0,quality=92)
    report={'version':1,'imageId':TARGET,'enabled':False,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
        'files':files,'dimensions':[1920,1080],'stars':stars,'groups':{n:sum(p['group']==n for p in stars) for n in NAMES[:3]},
        'gains':GAINS,'maxDelta8bit':float(delta.max()*255),'meanDelta8bit':float(delta.mean()*255),
        'extraTextureBytes':1920*1080*4*4,'previewNote':'Synthetic slow envelope; not live audio or native-performance evidence'}
    (out/'prototype.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k not in ('stars','files')}))

if __name__=='__main__': prepare(Path(sys.argv[1]),Path(sys.argv[2]))
