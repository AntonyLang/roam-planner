"""MCP resources and ranged reads share unchanged, versioned Markdown archives."""
import hashlib
import json
from itertools import islice
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from .corpus import iter_articles


def article_uri(source, language, title, version):
    return f'guide://{source}/{language}/{quote(title, safe="")}/{version}'


class Archive:
    def __init__(self, root):
        self.root = Path(root)

    def catalogs(self):
        for catalog in sorted(self.root.glob('wikivoyage/*/*/catalog.json')):
            yield 'wikivoyage', catalog.parent.name, catalog
        for catalog in sorted(self.root.glob('wikipedia/*/catalog.json')):
            yield 'wikipedia', None, catalog

    def articles(self, source=None, language=None):
        for provider, lang, catalog in self.catalogs():
            if source and provider != source:
                continue
            for article in iter_articles(catalog):
                actual_language = article.get('language') or lang or 'zh'
                if language and actual_language != language:
                    continue
                path = (catalog.parent / article['markdown_path']).resolve()
                if not path.is_relative_to(catalog.parent.resolve()):
                    raise ValueError('Archive path leaves catalog directory')
                version = article.get('sha256') or hashlib.sha256(path.read_bytes()).hexdigest()
                yield {**article, 'source': provider, 'language': actual_language, 'file': path,
                       'version': version, 'uri': article_uri(provider, actual_language, article['title'], version)}

    def list_resources(self, cursor=None, limit=100):
        offset = int(cursor or 0)
        def entries():
            yield {'uri': 'guide://catalog', 'name': '攻略目录', 'mimeType': 'application/json'}
            for article in self.articles():
                yield {'uri': article['uri'], 'name': article['title'], 'mimeType': 'text/markdown',
                       'description': f"{article['source']} · {article['language']} · {article['version'][:12]}"}
        rows = list(islice(entries(), offset, offset + limit + 1))
        return {'resources': rows[:limit], **({'nextCursor': str(offset + limit)} if len(rows) > limit else {})}

    def locate(self, uri):
        parsed = urlparse(uri)
        if parsed.scheme != 'guide':
            raise ValueError('Expected a guide:// resource URI')
        parts = parsed.path.strip('/').split('/')
        if len(parts) < 3:
            raise ValueError('Article URI must identify language, title and version')
        language, title, version = parts[:3]
        for article in self.articles(parsed.netloc, language):
            if article['title'] == unquote(title) and article['version'] == version:
                text = article['file'].read_bytes().decode('utf-8')
                if hashlib.sha256(text.encode('utf-8')).hexdigest() != version:
                    raise ValueError('Archived article version changed')
                return article, text
        raise ValueError('Article resource/version not found')

    def read(self, uri, section_path=None, start=None, length=None):
        """start is an absolute, zero-based Unicode code point offset in the article."""
        article, text = self.locate(uri)
        lower, upper = 0, len(text)
        if section_path is not None:
            section = next((s for s in article.get('sections', []) if s['path'] == section_path), None)
            if section is None:
                raise ValueError('Section path not found')
            lower, upper = section['start_char'], section['end_char']
            # A parent without direct body still exposes its descendants.
            descendants = [s for s in article['sections'] if s['path'][:len(section_path)] == section_path]
            if descendants:
                upper = max(s['end_char'] for s in descendants)
        position = lower if start is None else start
        if position < lower or position > upper:
            raise ValueError('start lies outside the requested article/section')
        stop = upper if length is None else min(position + length, upper)
        return {'uri': article['uri'], 'section_path': section_path, 'range': [position, stop],
                'text': text[position:stop], 'complete': position == lower and stop == upper,
                'section_range': [lower, upper],
                'next_start': stop if stop < upper else None,
                'coordinate_unit': 'unicode-code-points', 'source_url': article.get('source_url', article.get('url')),
                'license': article.get('license', 'CC-BY-SA-4.0')}

    def read_resource(self, uri):
        parsed = urlparse(uri)
        if parsed.netloc == 'catalog':
            parts = [unquote(p) for p in parsed.path.split('/') if p]
            if not parts:
                groups = sorted({(article['source'], article['language']) for article in self.articles()})
                value = {'directories': [{'source': s, 'language': l, 'uri': f'guide://catalog/{s}/{l}'} for s, l in groups]}
            else:
                value = {'articles': [{'title': a['title'], 'uri': a['uri'], 'toc_uri': a['uri'] + '/toc'}
                                      for a in self.articles(parts[0], parts[1] if len(parts) > 1 else None)]}
            return {'contents': [{'uri': uri, 'mimeType': 'application/json', 'text': json.dumps(value, ensure_ascii=False)}]}
        if parsed.path.endswith('/toc'):
            article, text = self.locate(uri[:-4])
            value = {'uri': article['uri'], 'title': article['title'], 'coordinate_unit': 'unicode-code-points',
                     'range': [0, len(text)], 'sections': [{'section_path': s['path'], 'range': [s['start_char'], s['end_char']]}
                                                        for s in article.get('sections', [])]}
            return {'contents': [{'uri': uri, 'mimeType': 'application/json', 'text': json.dumps(value, ensure_ascii=False)}]}
        value = self.read(uri)
        return {'contents': [{'uri': uri, 'mimeType': 'text/markdown', 'text': value['text']}]}

    @staticmethod
    def block(passage, section):
        from .corpus import content_range
        origin, end = content_range(section)
        return {'text': passage['text'],
                'uri': article_uri(passage['source'], passage['language'], passage['article_title'], passage['sha256']),
                'section_path': passage['path'],
                'range': [passage['start_char'] + passage['section_start'], passage['start_char'] + passage['section_end']],
                'section_coverage': len(passage['text']) / max(1, end - origin)}

    @staticmethod
    def ranked_blocks(ranking, passages, sections, limit, chars):
        """Apply the Agent's text budget without losing original Unicode coordinates."""
        output = []
        for row in ranking[:limit]:
            if chars <= 0:
                break
            passage = passages[row['id']]
            retained = passage['text'][:chars]
            block = Archive.block({**passage, 'text': retained,
                                   'section_end': passage['section_start'] + len(retained)},
                                  sections[passage['section_id']])
            output.append(block)
            chars -= len(retained)
        return output
