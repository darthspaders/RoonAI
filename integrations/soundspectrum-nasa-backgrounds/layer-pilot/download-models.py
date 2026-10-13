"""Explicit model setup only. No NASA/image ingestion; fixed public SHA-256 pins."""
import hashlib,json,os,pathlib,urllib.request
here=pathlib.Path(__file__).resolve().parent
work=here.parents[2]/'data/nasa-whitecap/layer-pilot'
pins=json.loads((here/'models.lock.json').read_text())
for name,pin in pins.items():
    target=work/name
    if target.is_symlink(): raise ValueError('Linked model path preserved')
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists():
        with target.open('rb') as f: actual=hashlib.file_digest(f,'sha256').hexdigest()
        if actual!=pin['sha256']: raise ValueError('Existing model differs: '+name)
        continue
    tmp=target.with_name(target.name+'.part');sha=hashlib.sha256();total=0
    with urllib.request.urlopen(pin['url'],timeout=60) as response,tmp.open('xb') as output:
        while chunk:=response.read(1024*1024):
            total+=len(chunk)
            if total>pin['bytes']: raise ValueError('Model exceeds pinned size')
            sha.update(chunk);output.write(chunk)
    if total!=pin['bytes'] or sha.hexdigest()!=pin['sha256']: raise ValueError('Downloaded model hash mismatch: '+name)
    os.replace(tmp,target)
    print(name, 'verified')
