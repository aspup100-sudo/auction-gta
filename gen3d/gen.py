import os, sys, json, traceback
from gradio_client import Client
mode = open('gen3d/run.txt').read().split()[0]
os.makedirs('gen3d/out', exist_ok=True)
if mode == 'probe':
    for s in ['JeffreyXiang/TRELLIS','trellis-community/TRELLIS','tencent/Hunyuan3D-2','tencent/Hunyuan3D-2mv','tencent/Hunyuan3D-2.1','stabilityai/stable-fast-3d']:
        print('=====', s, flush=True)
        try:
            c = Client(s)
            c.view_api(print_info=True)
        except Exception as e:
            print('FAIL', repr(e)[:500])
        sys.stdout.flush()
