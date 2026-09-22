"""Read the authoritative backend after migration; never silently use stale files."""
import json
import os
from urllib.request import Request, urlopen


def load_board_file(path, endpoint):
    api = os.environ.get('TB_API_URL', 'https://zdodflwtphnzvfkuarmn.supabase.co/functions/v1/board-api').rstrip('/')
    if os.environ.get('TB_OFFLINE_SNAPSHOT') == '1':
        return json.loads(path.read_text())
    headers = {'X-Auth-Token': os.environ.get('TB_AUTH_TOKEN', ''), 'User-Agent': 'ThumbnailBoard/2.0'}
    with urlopen(Request(api + endpoint, headers=headers), timeout=30) as response:
        data = json.load(response)
    if not isinstance(data, list):
        raise RuntimeError('Invalid response from ' + endpoint)
    return data
