#!/usr/bin/env python3
"""Optional visual review of inbox candidates with local vision + Jev. No auto-approval."""
import argparse
import json
import os
import sys
from pathlib import Path
from urllib.request import Request, urlopen
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from auto_tag import ALL_VALID, download_thumb_b64
from jev_tagger import analyze_thumbnail, post_json

parser=argparse.ArgumentParser()
parser.add_argument('--limit',type=int,default=10)
parser.add_argument('--model',default='qwen2.5vl:7b')
args=parser.parse_args()
api=os.environ.get('TB_API_URL','').rstrip('/')
token=os.environ.get('TB_AUTH_TOKEN','')
if not api or not token or not os.environ.get('TYPESAFE_API_KEY'):
    parser.error('Set TB_API_URL, TB_AUTH_TOKEN and TYPESAFE_API_KEY in your private environment.')
with urlopen(Request(api+'/api/inbox'),timeout=30) as response:
    items=json.load(response)
for item in [v for v in items if v.get('visualQuality') is None][:args.limit]:
    try:
        image=download_thumb_b64(item['id'],item.get('thumbnailUrl',''))
        if not image:
            print(item['id'],'image unavailable; kept in inbox')
            continue
        result=analyze_thumbnail(image,ALL_VALID,args.model)
        payload={'id':item['id'],'tags':result['tags'],'visualQuality':result['visual_quality'],'visualConfidence':result['visual_confidence'],'visualNotes':result['visual_observations']}
        post_json(api+'/api/inbox/visual-review',payload,{'X-Auth-Token':token},timeout=30)
        print(item['id'],'visual score',result['visual_quality'],'(0–4), awaiting review')
    except Exception as error:
        print(item['id'],'review failed:',error,file=sys.stderr)
