import os, sys, json, shutil, traceback, time
from gradio_client import Client, handle_file
args = open('gen3d/run.txt').read().split()
mode, names = args[0], args[1:] or ['boy', 'girl', 'shiba', 'cat']
OUT = 'gen3d/out'; os.makedirs(OUT, exist_ok=True)
URL = 'https://raw.githubusercontent.com/aspup100-sudo/auction-gta/main/previews/gem/%s_%s.png'
log = open(f'{OUT}/log_{mode}.txt', 'a')
def P(*a):
    s = ' '.join(str(x) for x in a); print(s, flush=True); log.write(s + '\n'); log.flush()

def api(c):
    d = c.view_api(return_format='dict', print_info=False)
    return {k: [p['parameter_name'] for p in v['parameters']] for k, v in d['named_endpoints'].items()}

def save(src, dst):
    if isinstance(src, dict): src = src.get('value') or src.get('path') or src.get('name')
    shutil.copy(src, dst); P('saved', dst, os.path.getsize(dst))

def trellis(c, n, multi):
    eps = api(c); P('endpoints', json.dumps(eps))
    if '/start_session' in eps: c.predict(api_name='/start_session')
    views = ['front', 'side', 'back'] if multi else ['front']
    files = [handle_file(URL % (n, v)) for v in views]
    kw = dict(seed=0, ss_guidance_strength=7.5, ss_sampling_steps=12, slat_guidance_strength=3.0, slat_sampling_steps=12, multiimage_algo='stochastic')
    p = eps['/image_to_3d']
    if multi:
        pre = c.predict(images=[{'image': f, 'caption': None} for f in files], api_name='/preprocess_images') if '/preprocess_images' in eps else [{'image': f, 'caption': None} for f in files]
        kw.update(image=None, multiimages=pre)
        if 'is_multiimage' in p: kw['is_multiimage'] = True
    else:
        pre = c.predict(image=files[0], api_name='/preprocess_image')
        kw.update(image=handle_file(pre) if isinstance(pre, str) else pre, multiimages=[])
        if 'is_multiimage' in p: kw['is_multiimage'] = False
    kw = {k: v for k, v in kw.items() if k in p}
    t = time.time(); r = c.predict(**kw, api_name='/image_to_3d'); P('image_to_3d', round(time.time() - t), 's', str(r)[:200])
    vid = r.get('video') if isinstance(r, dict) else r
    try: save(vid, f'{OUT}/{n}_trellis_{"mv" if multi else "1"}.mp4')
    except Exception as e: P('no video', e)
    pe = eps['/extract_glb']; kw2 = {k: v for k, v in dict(mesh_simplify=0.9, texture_size=2048).items() if k in pe}
    r = c.predict(**kw2, api_name='/extract_glb'); P('extract_glb', str(r)[:200])
    save(r[1] if isinstance(r, (list, tuple)) else r, f'{OUT}/{n}_trellis_{"mv" if multi else "1"}.glb')

def sf3d(n):
    c = Client('stabilityai/stable-fast-3d')
    r = c.predict(input_image=handle_file(URL % (n, 'front')), foreground_ratio=0.85, remesh_option='None', vertex_count=-1, texture_size=2048, api_name='/run_button')
    save(r[1], f'{OUT}/{n}_sf3d.glb')

for n in names:
    for multi in ([True, False] if mode in ('trellis', 'all') else []):
        for space in ['JeffreyXiang/TRELLIS', 'trellis-community/TRELLIS']:
            try:
                P('=====', n, space, 'multi' if multi else 'single')
                trellis(Client(space), n, multi); break
            except Exception as e:
                P('FAIL', repr(e)[:800]); traceback.print_exc()
    if mode in ('sf3d', 'all'):
        try: P('=====', n, 'sf3d'); sf3d(n)
        except Exception as e: P('FAIL sf3d', repr(e)[:800])
