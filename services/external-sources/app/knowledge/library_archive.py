"""Archive-compatible reads backed by the prepared SQLite library."""
import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from .archive import Archive
from .library import LibraryStore


class LibraryArchive(Archive):
    def __init__(self, knowledge_root, database):
        super().__init__(knowledge_root)
        self.database = Path(database).resolve()

    def articles(self, source=None, language=None):
        """Stream article records in archive order, resolving metadata from SQLite."""
        with LibraryStore(self.database, self.root) as store:
            clauses = []
            values = []
            if source:
                clauses.append('source=?')
                values.append(source)
            if language:
                clauses.append('language=?')
                values.append(language)
            where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
            cursor = store.connection.execute(
                'SELECT * FROM articles' + where + ' ORDER BY rowid', values,
            )
            for row in cursor:
                article = store._article_dict(row)
                article['file'] = (self.root / article['relative_file']).resolve()
                article['sections'] = self._sections(store, article['article_id'])
                yield article

    def list_articles(self, query='', offset=0, limit=30):
        with LibraryStore(self.database, self.root) as store:
            store.connection.create_function('casefold', 1, str.casefold, deterministic=True)
            where = ' WHERE instr(casefold(title),?)>0' if query else ''
            values = [query.casefold(), limit + 1, offset] if query else [limit + 1, offset]
            rows = store.connection.execute(
                'SELECT article_id,title,language,source,uri FROM articles' + where
                + ' ORDER BY rowid LIMIT ? OFFSET ?', values,
            ).fetchall()
        return {
            'articles': [
                {'id': row['article_id'], 'title': row['title'], 'language': row['language'],
                 'source': row['source'], 'uri': row['uri']}
                for row in rows[:limit]
            ],
            'has_more': len(rows) > limit,
        }

    @staticmethod
    def _sections(store, article_id):
        rows = store.connection.execute(
            'SELECT * FROM sections WHERE article_id=? ORDER BY ordinal', (article_id,),
        )
        result = []
        for row in rows:
            section = dict(row)
            section['path'] = json.loads(section.pop('path_json'))
            section['selected'] = bool(section['selected'])
            result.append(section)
        return result

    def locate(self, uri):
        parsed = urlparse(uri)
        if parsed.scheme != 'guide':
            raise ValueError('Expected a guide:// resource URI')
        if len(parsed.path.strip('/').split('/')) < 3:
            raise ValueError('Article URI must identify language, title and version')
        with LibraryStore(self.database, self.root) as store:
            article = store.get_article(uri)
            if article is None:
                raise ValueError('Article resource/version not found')
            sections = self._sections(store, article['article_id'])

        path = (self.root / article['relative_file']).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError('Archive path leaves knowledge root')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != article['version']:
            raise ValueError('Archived article version changed')
        article.update(file=path, sections=sections)
        return article, raw.decode('utf-8')

    def read(self, uri, section_path=None, start=None, length=None):
        """Read archived Markdown using zero-based Unicode code-point ranges."""
        article, text = self.locate(uri)
        lower, upper = 0, len(text)
        if section_path is not None:
            section = next((s for s in article.get('sections', []) if s['path'] == section_path), None)
            if section is None:
                raise ValueError('Section path not found')
            lower, upper = section['start_char'], section['end_char']
            descendants = [s for s in article['sections'] if s['path'][:len(section_path)] == section_path]
            if descendants:
                upper = max(s['end_char'] for s in descendants)
        position = lower if start is None else start
        if position < lower or position > upper:
            raise ValueError('start lies outside the requested article/section')
        stop = upper if length is None else min(position + length, upper)
        return {
            'uri': article['uri'],
            'section_path': section_path,
            'range': [position, stop],
            'text': text[position:stop],
            'complete': position == lower and stop == upper,
            'section_range': [lower, upper],
            'next_start': stop if stop < upper else None,
            'coordinate_unit': 'unicode-code-points',
            'source_url': article.get('source_url', article.get('url')),
            'license': article.get('license', 'CC-BY-SA-4.0'),
        }

    def list_resources(self, cursor=None, limit=100):
        offset = int(cursor or 0)
        with LibraryStore(self.database, self.root) as store:
            if offset == 0:
                rows = store.connection.execute(
                    'SELECT uri,title,source,language,version FROM articles ORDER BY rowid LIMIT ?',
                    (limit,),
                ).fetchall()
                candidates = [{'uri': 'guide://catalog', 'name': '攻略目录', 'mimeType': 'application/json'}]
                candidates.extend(self._resource_row(row) for row in rows)
            else:
                rows = store.connection.execute(
                    'SELECT uri,title,source,language,version FROM articles ORDER BY rowid LIMIT ? OFFSET ?',
                    (limit + 1, offset - 1),
                ).fetchall()
                candidates = [self._resource_row(row) for row in rows]
        more = len(candidates) > limit
        return {
            'resources': candidates[:limit],
            **({'nextCursor': str(offset + limit)} if more else {}),
        }

    @staticmethod
    def _resource_row(row):
        return {
            'uri': row['uri'],
            'name': row['title'],
            'mimeType': 'text/markdown',
            'description': f"{row['source']} · {row['language']} · {row['version'][:12]}",
        }

    def read_resource(self, uri):
        parsed = urlparse(uri)
        if parsed.netloc == 'catalog':
            parts = [part for part in parsed.path.split('/') if part]
            with LibraryStore(self.database, self.root) as store:
                if not parts:
                    groups = store.connection.execute(
                        'SELECT DISTINCT source,language FROM articles ORDER BY source,language',
                    ).fetchall()
                    value = {'directories': [
                        {'source': row['source'], 'language': row['language'],
                         'uri': f"guide://catalog/{row['source']}/{row['language']}"}
                        for row in groups
                    ]}
                    return {'contents': [{'uri': uri, 'mimeType': 'application/json',
                                         'text': json.dumps(value, ensure_ascii=False)}]}

                source = parts[0]
                language = parts[1] if len(parts) > 1 else None
                offset = int(parse_qs(parsed.query).get('cursor', ['0'])[0])
                clauses = ['source=?']
                values = [source]
                if language:
                    clauses.append('language=?')
                    values.append(language)
                values.extend((101, offset))
                rows = store.connection.execute(
                    'SELECT title,uri FROM articles WHERE ' + ' AND '.join(clauses)
                    + ' ORDER BY rowid LIMIT ? OFFSET ?', values,
                ).fetchall()
            has_more = len(rows) > 100
            value = {'articles': [
                {'title': row['title'], 'uri': row['uri'], 'toc_uri': row['uri'] + '/toc'}
                for row in rows[:100]
            ]}
            if has_more:
                next_uri = urlunparse((parsed.scheme, parsed.netloc, parsed.path, '',
                                       urlencode({'cursor': offset + 100}), ''))
                value['next_uri'] = next_uri
            return {'contents': [{'uri': uri, 'mimeType': 'application/json',
                                  'text': json.dumps(value, ensure_ascii=False)}]}
        if parsed.path.endswith('/toc'):
            article, text = self.locate(uri[:-4])
            value = {
                'uri': article['uri'],
                'title': article['title'],
                'coordinate_unit': 'unicode-code-points',
                'range': [0, len(text)],
                'sections': [
                    {'section_path': section['path'],
                     'range': [section['start_char'], section['end_char']]}
                    for section in article.get('sections', [])
                ],
            }
            return {'contents': [{'uri': uri, 'mimeType': 'application/json',
                                  'text': json.dumps(value, ensure_ascii=False)}]}
        value = self.read(uri)
        return {'contents': [{'uri': uri, 'mimeType': 'text/markdown', 'text': value['text']}]}
