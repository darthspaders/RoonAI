"""Source-bound offline pilot. No source writes, acquisition or runtime publication."""
import hashlib, json, os, pathlib, sys, time
import cv2
import numpy as np
from PIL import Image, ImageDraw

HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[2]
WORK=ROOT/'data/nasa-whitecap/layer-pilot'
LIB=ROOT/'data/nasa-whitecap/library'
PLAN=json.loads((HERE/'plan.json').read_text())

def digest(p):
    with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()

def json_write(p,obj):
    tmp=p.with_name(p.name+'.part')
    tmp.write_text(json.dumps(obj,indent=2)+'\n',encoding='utf-8')
    os.replace(tmp,p)

def source(image_id):
    cfg=next(e for e in PLAN['images'] if e['id']==image_id)
    entry=next(e for e in json.loads((LIB/'library.json').read_text(encoding='utf-8'))['entries'] if e['id']==image_id)
    if entry['sha256']!=cfg['sha256'] or entry['file']!=cfg['sha256']+'.jpg': raise ValueError('Catalog/source mismatch')
    p=LIB/entry['file']
    if p.is_symlink() or digest(p)!=cfg['sha256']: raise ValueError('Source hash mismatch')
    rgb=np.array(Image.open(p).convert('RGB'))
    if rgb.shape!=(2160,3840,3): raise ValueError('Expected existing 4K presentation')
    folder=WORK/(image_id+'-'+cfg['sha256'][:12]);folder.mkdir(exist_ok=True)
    # Detect only exterior contain margins; retain the exact crop transform.
    live=(rgb.max(axis=2)>8)
    xs=np.flatnonzero(live.mean(axis=0)>.15);ys=np.flatnonzero(live.mean(axis=1)>.15)
    box=[int(xs[0]),int(ys[0]),int(xs[-1]+1),int(ys[-1]+1)]
    return cfg,entry,rgb,folder,box

def input_stage(image_id):
    cfg,entry,rgb,folder,box=source(image_id)
    x0,y0,x1,y1=box
    p=folder/'input.png'
    tmp=folder/'input.part.png'
    Image.fromarray(rgb[y0:y1,x0:x1]).save(tmp);os.replace(tmp,p)
    receipt={'imageId':image_id,'sourceSha256':cfg['sha256'],'folder':str(folder),'input':str(p),'contentBox':box}
    json_write(folder/'input.json',receipt)
    print(json.dumps(receipt))

def run_sam(rgb,cfg,folder):
    import torch
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    model=build_sam2('configs/sam2.1/sam2.1_hiera_b+.yaml',str(WORK/'models/sam2.1_hiera_base_plus.pt'),device='cpu',apply_postprocessing=False)
    predictor=SAM2ImagePredictor(model)
    with torch.inference_mode():
        predictor.set_image(rgb)
        masks,scores,_=predictor.predict(point_coords=np.array(cfg['points'])*[rgb.shape[1],rgb.shape[0]],point_labels=np.array(cfg['labels']),multimask_output=True)
    for i,m in enumerate(masks): Image.fromarray(m.astype('uint8')*255).save(folder/('sam-option-%d.png'%i))
    pick=int(np.argmax(scores))
    mask=masks[pick].astype('uint8')*255
    Image.fromarray(mask).save(folder/'sam-mask.png')
    json_write(folder/'sam.json',{'scores':scores.tolist(),'selected':pick,'points':cfg['points'],'labels':cfg['labels'],'coverage':float(mask.mean()/255)})
    return mask

def run_depth(rgb,folder):
    import torch
    sys.path.insert(0,str(WORK/'depth-anything-3/src'))
    from depth_anything_3.cfg import create_object,load_config
    from depth_anything_3.utils.io.input_processor import InputProcessor
    from safetensors.torch import load_file
    cfg=load_config(str(WORK/'depth-anything-3/src/depth_anything_3/configs/da3mono-large.yaml'))
    model=create_object(cfg).eval()
    weights=load_file(str(WORK/'models/da3.safetensors'))
    model.load_state_dict({k.removeprefix('model.'):v for k,v in weights.items()},strict=True)
    del weights
    batch,_,_=InputProcessor()(image=[rgb],process_res=504,process_res_method='upper_bound_resize',num_workers=1,sequential=True)
    if batch.ndim==4: batch=batch.unsqueeze(0)
    with torch.inference_mode(): prediction=model(batch)
    d=prediction['depth'].squeeze().cpu().numpy()
    if not np.isfinite(d).all(): raise ValueError('Non-finite inferred depth')
    lo,hi=np.percentile(d,[2,98])
    normalized=np.clip((d-lo)/max(float(hi-lo),1e-6),0,1)
    d=cv2.resize(normalized,(rgb.shape[1],rgb.shape[0]),interpolation=cv2.INTER_CUBIC)
    d=np.clip(d,0,1)
    cv2.imwrite(str(folder/'depth-da3.png'),np.round(d*65535).astype('uint16'))
    json_write(folder/'depth.json',{'model':'DA3MONO-LARGE','processResolution':504,'depthMeaning':'relative artistic candidate, not astronomical distance','inputShape':list(batch.shape),'range':[float(lo),float(hi)]})
    return d

def inpaint(rgb,mask,folder):
    import torch
    model=torch.jit.load(str(WORK/'models/big-lama.pt'),map_location='cpu').eval()
    # Work at 1024 max; only selected hidden margin pixels are ever composited.
    h,w=rgb.shape[:2];scale=min(1,1024/max(h,w))
    size=(round(w*scale),round(h*scale))
    small=cv2.resize(rgb,size,interpolation=cv2.INTER_AREA)
    m=cv2.resize(mask,size,interpolation=cv2.INTER_NEAREST)
    ph=(-size[1])%8;pw=(-size[0])%8
    image=np.pad(small.astype('float32')/255,((0,ph),(0,pw),(0,0)),mode='reflect')
    mm=np.pad((m>0).astype('float32'),((0,ph),(0,pw)),mode='reflect')
    with torch.inference_mode():
        output=model(torch.from_numpy(image.transpose(2,0,1)[None]),torch.from_numpy(mm[None,None]))[0].permute(1,2,0).cpu().numpy()
    output=cv2.resize(output[:size[1],:size[0]],(w,h),interpolation=cv2.INTER_CUBIC)
    output=np.clip(np.round(output*255),0,255).astype('uint8')
    result=rgb.copy();result[mask>0]=output[mask>0]
    Image.fromarray(result).save(folder/'inpaint-candidate.png')
    return result

def analyze(image_id):
    import torch
    torch.set_num_threads(4);torch.set_num_interop_threads(2)
    start=time.monotonic()
    cfg,entry,original,folder,box=source(image_id)
    x0,y0,x1,y1=box;rgb=original[y0:y1,x0:x1];h,w=rgb.shape[:2]
    times={}
    nox=cv2.imread(str(folder/'nox.tiff'),cv2.IMREAD_UNCHANGED)
    if nox is None or nox.shape!=rgb.shape: raise ValueError('nox output dimensions mismatch')
    if nox.dtype==np.uint16: nox=nox.astype('float32')/257
    elif nox.dtype.kind=='f': nox=nox*255
    nox=np.clip(np.round(nox[:,:,::-1]),0,255).astype('uint8')
    Image.fromarray(nox).save(folder/'starless-candidate.png')
    # Positive residual ensures lossless 8-bit neutral reconstruction. Keep the
    # unconstrained model output for review, never silently rewrite the source.
    starless=np.minimum(rgb,nox)
    stars=rgb-starless
    Image.fromarray(starless).save(folder/'starless.png')
    Image.fromarray(stars).save(folder/'stars.png')
    t=time.monotonic()
    if (folder/'depth-da3.png').exists(): depth=cv2.imread(str(folder/'depth-da3.png'),-1).astype('float32')/65535
    else: depth=run_depth(rgb,folder)
    times['depthSeconds']=round(time.monotonic()-t,2)
    mask=np.zeros((h,w),dtype='uint8')
    if cfg['cloud']:
        t=time.monotonic()
        previous=json.loads((folder/'sam.json').read_text()) if (folder/'sam.json').exists() else {}
        cached=not cfg.get('rebuildSam',False) and previous.get('points')==cfg['points'] and previous.get('labels')==cfg['labels'] and (folder/'sam-mask.png').exists()
        mask=np.array(Image.open(folder/'sam-mask.png')) if cached else run_sam(rgb,cfg,folder)
        times['samSeconds']=round(time.monotonic()-t,2)
        from scipy.ndimage import binary_fill_holes
        # SAM made tiny holes around embedded stars. Fill enclosed holes in the
        # cloud cutout; stellar separation is handled independently below.
        mask=binary_fill_holes(mask>0).astype('uint8')*255
    # nox is not an astronomical classifier. Never remove or brighten the
    # compact galaxies in the sky just because it included them in a residual.
    starless=np.where((mask>0)[:,:,None],starless,rgb)
    stars=rgb-starless
    Image.fromarray(starless).save(folder/'starless.png')
    Image.fromarray(stars).save(folder/'stars.png')
    Image.fromarray(mask).save(folder/'cloud-mask.png')
    # Three-pixel inward feather. Exterior sky does not get dragged into clouds.
    dist=cv2.distanceTransform((mask>0).astype('uint8'),cv2.DIST_L2,5)
    alpha=np.clip(dist/4,0,1)
    alpha=np.round(alpha*255).astype('uint8')
    ring=((alpha==255)&(dist<max(cfg['maxMotionPixels'])+12)).astype('uint8')*255
    Image.fromarray(ring).save(folder/'inpaint-mask.png')
    background=starless.copy()
    if np.any(ring):
        t=time.monotonic()
        background=inpaint(starless,ring,folder)
        times['lamaSeconds']=round(time.monotonic()-t,2)
    # Deep field is deliberately static: no model removal or invented gaps in
    # the exported control. Candidate output remains available for rejection.
    if not cfg['cloud']: background=rgb.copy();stars[:]=0
    def canvas(pixels):
        shape=(2160,3840)+pixels.shape[2:]
        out=np.zeros(shape,dtype=pixels.dtype);out[y0:y1,x0:x1]=pixels
        return out
    # Keep the source's JPEG edge pixels in the contain margins too. They are
    # nearly black, but replacing them with zero prevents exact recomposition.
    background_full=original.copy();background_full[y0:y1,x0:x1]=background
    Image.fromarray(background_full).save(folder/'background.png')
    Image.fromarray(canvas(np.dstack((starless,alpha)))).save(folder/'cloud-rgba.png')
    Image.fromarray(canvas(stars)).save(folder/'stellar.png')
    # Compare hand-authored shallow cloud relief against inferred depth. The
    # reviewed segmentation bounds both; DA3 is an inspection asset for now.
    manual=cv2.GaussianBlur((mask>0).astype('float32'),(0,0),18)
    yy,xx=np.mgrid[0:h,0:w].astype('float32')
    manual*=np.clip(.35+.65*yy/max(h-1,1),0,1)
    cv2.imwrite(str(folder/'depth-manual.png'),np.round(manual*65535).astype('uint16'))
    full=canvas(manual)
    # Force a generous zero-motion perimeter around the content, not the full
    # presentation: pillarbox edges must not expose blank strips.
    edge=np.minimum.reduce([xx,yy,w-1-xx,h-1-yy])
    taper=np.clip(edge/90,0,1);taper=taper*taper*(3-2*taper)
    weights=canvas(manual*taper)
    # Large diffraction stars can survive nox. Pin a neighbourhood around
    # already reviewed catalog stars instead of letting their cores drift.
    motion=json.loads((LIB/'motion/active.json').read_text())
    anchors=next((e.get('stars',[]) for e in motion['entries'] if e['imageId']==image_id),[])
    cols,rows=cfg.get('meshSize',[65,37])
    if cfg.get('interiorOnly'):
        # Entire triangles near the cutout edge stay still. Only cloud interiors
        # may move; neither sky nor silhouette is sampled by a moving triangle.
        safe=cv2.distanceTransform((mask>0).astype('uint8'),cv2.DIST_L2,5)
        cell=(3840/(cols-1))**2+(2160/(rows-1))**2
        safe=np.clip((safe-(cell**.5+max(cfg['maxMotionPixels'])))/150,0,1)
        weights=canvas(safe*safe*(3-2*safe)*taper)
    gy,gx=np.mgrid[0:rows,0:cols].astype('float32')
    gx*=3840/(cols-1);gy*=2160/(rows-1)
    grid=cv2.resize(weights,(cols,rows),interpolation=cv2.INTER_AREA)
    for star in anchors:
        distance=np.sqrt((gx-star[0]*3840)**2+(gy-star[1]*2160)**2)
        # Vertex pinning extends beyond the affected core by one grid cell.
        protect=np.clip((distance-125)/120,0,1)
        grid*=protect*protect*(3-2*protect)
    grid[[0,-1],:]=0;grid[:,[0,-1]]=0
    af=alpha[:,:,None].astype('float32')/255
    neutral=np.round(background*(1-af)+starless*af+stars).clip(0,255).astype('uint8')
    if not cfg['cloud']: neutral=background
    neutral_full=original.copy();neutral_full[y0:y1,x0:x1]=neutral
    delta=np.abs(neutral_full.astype('int16')-original.astype('int16'))
    # Real neutral is source-exact; source margins are rendered from the source
    # as a fallback. Black presentation padding remains zero in the pilot.
    names=['background.png','cloud-rgba.png','stellar.png']
    receipt={'version':1,'enabled':False,'imageId':image_id,'title':entry['title'],'sourceSha256':cfg['sha256'],'contentBox':box,
      'cloud':cfg['cloud'],'maxMotionPixels':cfg['maxMotionPixels'],'grid':[cols,rows,[round(float(v),6) for v in grid.flat]],
      'pinnedStars':len(anchors),'skyPreserved':True,
      'depthSelected':'manual-reviewed-mask','depthIsArtistic':True,'inpaintedPixels':int(np.count_nonzero(ring)),
      'neutralMaxError':int(delta.max()),'neutralMeanError':float(delta.mean()),'timing':times,
      'seconds':round(time.monotonic()-start,2),'files':{n:digest(folder/n) for n in names},'review':'pending'}
    json_write(folder/'candidate.json',receipt)
    # Inspection sheet is explicitly a derived pilot artifact.
    items=[('Source',rgb),('nox candidate',nox),('Positive stellar residual',np.clip((rgb-np.minimum(rgb,nox)).astype('float32')*2,0,255).astype('uint8')),
           ('SAM cloud mask',cv2.cvtColor(mask,cv2.COLOR_GRAY2RGB)),('DA3 artistic depth',cv2.applyColorMap(np.round(depth*255).astype('uint8'),cv2.COLORMAP_TURBO)[:,:,::-1]),('Manual shallow relief',cv2.applyColorMap(np.round(manual*255).astype('uint8'),cv2.COLORMAP_TURBO)[:,:,::-1])]
    sheet=Image.new('RGB',(1200,800),(12,10,18));draw=ImageDraw.Draw(sheet)
    for i,(label,array) in enumerate(items):
        thumb=Image.fromarray(array);thumb.thumbnail((390,350));x=(i%3)*400;y=(i//3)*400
        sheet.paste(thumb,(x+(400-thumb.width)//2,y+34+(350-thumb.height)//2));draw.text((x+10,y+10),label,fill='white')
    sheet.save(folder/'inspection.jpg',quality=94)
    print(json.dumps({k:v for k,v in receipt.items() if k not in ['grid','files']}))

if __name__=='__main__':
    if sys.argv[1]=='input': input_stage(sys.argv[2])
    elif sys.argv[1]=='analyze': analyze(sys.argv[2])
    else: raise ValueError('Unknown preparation stage')
