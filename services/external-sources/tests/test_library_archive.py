import hashlib
import json
from pathlib import Path

from app.knowledge.archive import Archive
from app.knowledge.library import LibraryStore, prepare_library
from app.knowledge.library_archive import LibraryArchive


def make_library(tmp_path: Path, english_articles=103):
    root = tmp_path / 'knowledge'
    snapshot = root / 'wikivoyage' / '20261001'
    articles = {'en': [], 'zh': []}
    markdown_by_path = {}

    rows = [(f'Page {index:03d}', f'en-{index:03d}.md') for index in range(english_articles)]
    rows.append(('测试 𠮷', 'zh-test.md'))
    for language, title, relative in [
        ('en', title, path) for title, path in rows[:-1]
    ] + [('zh', rows[-1][0], rows[-1][1])]:
        if language == 'zh':
            markdown = '# 测试 𠮷\n## Parent\n中文正文与𠮷。\n### Child\n子段落𠮷🌐。\n## Next\n之后的章节。\n'
        else:
            markdown = f'# {title}\n## Parent\nParent body α.\n### Child\nChild text 𠮷🌐.\n## Next\nNext text.\n'
        parent_start = markdown.index('## Parent')
        child_start = markdown.index('### Child')
        next_start = markdown.index('## Next')
        sections = [
            {'title': 'Parent', 'level': 2, 'path': [title, 'Parent'],
             'start_char': parent_start, 'start_line': 2,
             'end_char': child_start, 'end_line': 4},
            {'title': 'Child', 'level': 3, 'path': [title, 'Parent', 'Child'],
             'start_char': child_start, 'start_line': 4,
             'end_char': next_start, 'end_line': 6},
            {'title': 'Next', 'level': 2, 'path': [title, 'Next'],
             'start_char': next_start, 'start_line': 6,
             'end_char': len(markdown), 'end_line': 8},
        ]
        raw = markdown.encode('utf-8')
        article = {
            'page_id': f'{language}-{title}',
            'title': title,
            'revision_id': 'rev-1',
            'revision_timestamp': '2026-10-01T00:00:00Z',
            'language': language,
            'source_url': f'https://{language}.wikivoyage.org/wiki/{title}',
            'revision_url': f'https://{language}.wikivoyage.org/w/index.php?oldid=rev-1',
            'history_url': f'https://{language}.wikivoyage.org/w/index.php?title={title}&action=history',
            'markdown_path': f'articles/{relative}',
            'markdown_bytes': len(raw),
            'characters': len(markdown) - parent_start,
            'sha256': hashlib.sha256(raw).hexdigest(),
            'sections': sections,
            'unknown_templates': {},
            'omitted_visuals': 0,
        }
        articles[language].append(article)
        markdown_by_path[(language, article['markdown_path'])] = markdown

    for language, entries in articles.items():
        language_root = snapshot / language
        (language_root / 'articles').mkdir(parents=True)
        for article in entries:
            path = language_root / article['markdown_path']
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(markdown_by_path[(language, article['markdown_path'])], encoding='utf-8', newline='')
        catalog = {
            'schema_version': 1,
            'source': 'wikivoyage',
            'language': language,
            'snapshot': '20261001',
            'license': 'CC-BY-SA-4.0',
            'license_url': 'https://creativecommons.org/licenses/by-sa/4.0/',
            'redirects': [],
            'articles': entries,
        }
        (language_root / 'catalog.json').write_text(
            json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8', newline='',
        )

    database = tmp_path / 'library.sqlite3'
    prepare_library(root, database, embedding_base_url='https://embedding.example/v1', embedding_model='fixture')
    return root, database, articles


def _content(result):
    return json.loads(result['contents'][0]['text'])


def test_library_archive_reads_parent_descendants_and_toc_with_unicode_ranges(tmp_path):
    root, database, _ = make_library(tmp_path, english_articles=1)
    archive = LibraryArchive(root, database)
    article = next(archive.articles(language='zh'))
    uri = article['uri']
    parent_path = ['测试 𠮷', 'Parent']
    parent = article['sections'][0]

    full_parent = archive.read(uri, section_path=parent_path)
    assert '中文正文与𠮷' in full_parent['text']
    assert '子段落𠮷🌐' in full_parent['text']
    assert '之后的章节' not in full_parent['text']
    assert full_parent['section_range'] == [parent['start_char'], article['sections'][1]['end_char']]
    assert full_parent['coordinate_unit'] == 'unicode-code-points'

    first = archive.read(uri, section_path=parent_path, length=8)
    second = archive.read(uri, section_path=parent_path, start=first['next_start'])
    assert first['text'] + second['text'] == full_parent['text']
    toc = _content(archive.read_resource(uri + '/toc'))
    assert toc['coordinate_unit'] == 'unicode-code-points'
    assert toc['sections'][1]['section_path'] == ['测试 𠮷', 'Parent', 'Child']
    full_resource = archive.read_resource(uri)['contents'][0]
    assert full_resource['mimeType'] == 'text/markdown'
    assert full_resource['text'] == article['file'].read_text(encoding='utf-8')

    iri = 'guide://wikivoyage/zh/测试 𠮷/' + article['version']
    assert archive.read(iri)['uri'] == uri


def test_library_archive_resources_use_bounded_sql_pagination_not_archive_scan(tmp_path, monkeypatch):
    root, database, _ = make_library(tmp_path, english_articles=103)
    archive = LibraryArchive(root, database)

    def no_catalog_scan(*args, **kwargs):
        raise AssertionError('LibraryArchive resource lookup rescanned Archive.articles')

    monkeypatch.setattr(archive, 'articles', no_catalog_scan)
    first = archive.list_resources(limit=2)
    second = archive.list_resources(cursor=first['nextCursor'], limit=2)
    assert first['resources'][0]['uri'] == 'guide://catalog'
    assert len(first['resources']) == len(second['resources']) == 2
    assert first['resources'][1]['uri'] != second['resources'][0]['uri']
    assert first['nextCursor'] == '2'

    root_catalog = _content(archive.read_resource('guide://catalog'))
    assert root_catalog['directories'] == [
        {'source': 'wikivoyage', 'language': 'en', 'uri': 'guide://catalog/wikivoyage/en'},
        {'source': 'wikivoyage', 'language': 'zh', 'uri': 'guide://catalog/wikivoyage/zh'},
    ]
    page1 = _content(archive.read_resource('guide://catalog/wikivoyage/en'))
    page2 = _content(archive.read_resource(page1['next_uri']))
    small = _content(archive.read_resource('guide://catalog/wikivoyage/zh'))
    assert len(page1['articles']) == 100
    assert page1['next_uri'] == 'guide://catalog/wikivoyage/en?cursor=100'
    assert len(page2['articles']) == 3
    assert 'next_uri' not in page2
    assert len(small['articles']) == 1
    assert 'next_uri' not in small

    listed = archive.list_articles(query='PAGE 00', offset=3, limit=2)
    assert [article['title'] for article in listed['articles']] == ['Page 003', 'Page 004']
    assert listed['has_more'] is True
    with LibraryStore(database, root) as store:
        expected = dict(store.connection.execute(
            "SELECT article_id,title,language,source,uri FROM articles WHERE title='Page 003'",
        ).fetchone())
    assert listed['articles'][0] == {
        'id': expected['article_id'], 'title': expected['title'],
        'language': expected['language'], 'source': expected['source'], 'uri': expected['uri'],
    }
    last_page = archive.list_articles(query='page 00', offset=9, limit=2)
    assert [article['title'] for article in last_page['articles']] == ['Page 009']
    assert last_page['has_more'] is False

    resource_page = archive.list_resources(limit=1)
    assert resource_page['resources'] == [{'uri': 'guide://catalog', 'name': '攻略目录', 'mimeType': 'application/json'}]
