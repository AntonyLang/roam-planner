"""Native search cards, private access records, and selected note details."""
from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import random
from enum import Enum

class SearchSortType(Enum):
    GENERAL='general'
    LATEST='time_descending'
    MOST_POPULAR='popularity_descending'

def get_search_id():
    number=(int(time.time()*1000)<<64)+random.randrange(2147483647)
    text='';alphabet='0123456789abcdefghijklmnopqrstuvwxyz'
    while number:
        number,remainder=divmod(number,36);text=alphabet[remainder]+text
    return text


def now():
    return datetime.now(timezone.utc).isoformat()


def profile_key(root):
    return hashlib.sha256((root / 'active-profile.json').read_bytes()).hexdigest()


@contextmanager
def connection(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path, timeout=10)
    c.execute('CREATE TABLE IF NOT EXISTS access(note_id TEXT,profile TEXT,token TEXT,channel TEXT,updated_at TEXT,PRIMARY KEY(note_id,profile))')
    try:
        with c:
            yield c
    finally:
        c.close()


async def query(client, root, db, *, keywords, count=3, sort='general', note_id=None):
    client.timeout = 15
    timestamp = now()
    source = {'type': 'mediacrawler-xhs', 'platform': 'xiaohongshu', 'mode': 'station_search'}
    if note_id:
        with connection(db) as c:
            row = c.execute('SELECT token,channel FROM access WHERE note_id=? AND profile=?',
                            (note_id, profile_key(root))).fetchone()
        if not row:
            raise ValueError('NOTE_ACCESS_MISSING: 先搜索获取当前登录态对应的笔记访问记录')
        value = await client.get_note_by_id(note_id, row[1], row[0])
        if not value:
            result, missing = {'note': None}, ['笔记不可用或已删除，未取得正文']
        else:
            returned_id = value.get('note_id') or value.get('noteId')
            if returned_id and returned_id != note_id:
                raise ValueError('NOTE_ID_MISMATCH: 上游详情与所请求笔记不一致')
            images = []
            for image in value.get('image_list') or []:
                url = image.get('url_default') or image.get('url')
                if url and url.startswith(('http://', 'https://')):
                    images.append({'url': url.split('?', 1)[0]})
            millis = value.get('time')
            published = datetime.fromtimestamp(millis / 1000, timezone.utc).isoformat() if isinstance(millis, (int, float)) and millis > 0 else None
            result = {'note': {'note_id': note_id, 'title': value.get('title') or '',
                'content': value.get('desc') or '', 'published_at': published,
                'author': (value.get('user') or {}).get('nickname'),
                'counts': value.get('interact_info') or {}, 'images': images,
                'content_scope': 'body_without_image_ocr',
                'url': 'https://www.xiaohongshu.com/explore/' + note_id}}
            missing = [] if result['note']['content'] else ['正文为空，图片文字尚未取得']
        source['interface'] = '/api/sns/web/v1/feed'
    else:
        sorts = {'general': SearchSortType.GENERAL, 'latest': SearchSortType.LATEST,
                 'popular': SearchSortType.MOST_POPULAR}
        value = await client.get_note_by_keyword(keyword=keywords, search_id=get_search_id(),
                                                 page=1, page_size=20, sort=sorts[sort])
        if not isinstance(value, dict) or not isinstance(value.get('items'), list):
            raise ValueError('INVALID_SEARCH_RESULT: 搜索响应缺少 items 列表')
        items = []
        with connection(db) as c:
            for entry in value['items']:
                card = entry.get('note_card') or {}
                ident = entry.get('id') or ''
                if not re.fullmatch(r'[0-9a-fA-F]{24}', ident) or not card:
                    continue
                token = entry.get('xsec_token')
                if token:
                    c.execute('INSERT OR REPLACE INTO access VALUES(?,?,?,?,?)',
                              (ident, profile_key(root), token, entry.get('xsec_source') or 'pc_search', timestamp))
                items.append({'note_id': ident, 'title': card.get('display_title') or card.get('title') or '',
                    'author': (card.get('user') or {}).get('nickname'),
                    'liked_count': (card.get('interact_info') or {}).get('liked_count'),
                    'content_scope': 'search_card', 'detail_available': bool(token),
                    'url': 'https://www.xiaohongshu.com/explore/' + ident})
                if len(items) >= count:
                    break
        result = {'items': items, 'returned_count': len(items), 'has_more': bool(value.get('has_more')),
                  'search_page': 1, 'limit': count}
        missing = [] if items else ['本次站内搜索未返回可用笔记']
        source['interface'] = '/api/sns/web/v1/search/notes'
    return {'result': result, 'source': source, 'queried_at': timestamp, 'data_time': None,
            'missing': missing, 'unknowns': ['作者经验未核验现时价格、营业或交通；未下载图片或执行 OCR'],
            'freshness': 'live_query', 'coordinate_system': None, 'units': {}}
