import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from app.knowledge.library import LibraryStore, prepare_library
from app.knowledge.library_lexical import (
    TOKENIZER_VERSION,
    LibraryLexical,
    build_library_lexical,
)


def make_library(tmp_path: Path):
    root = tmp_path / 'knowledge'
    snapshot = root / 'wikivoyage' / '20261001'
    articles = {
        'en': [('Alpha', 'alpha sharedterm harbor.')],
        'zh': [('青岛', '青岛 栈桥 sharedterm 𠮷🌐。')],
    }
    uris = {}
    for language, entries in articles.items():
        language_root = snapshot / language
        (language_root / 'articles').mkdir(parents=True)
        catalog_entries = []
        for index, (title, body) in enumerate(entries):
            markdown = f'# {title}\n## Details\n{body}\n'
            start = markdown.index('## Details')
            raw = markdown.encode('utf-8')
            article = {
                'page_id': f'{language}-{index}',
                'title': title,
                'revision_id': f'rev-{index}',
                'revision_timestamp': '2026-10-01T00:00:00Z',
                'language': language,
                'source_url': f'https://{language}.wikivoyage.org/wiki/{title}',
                'revision_url': f'https://{language}.wikivoyage.org/w/index.php?oldid=rev-{index}',
                'history_url': f'https://{language}.wikivoyage.org/w/index.php?title={title}&action=history',
                'markdown_path': f'articles/{index}.md',
                'markdown_bytes': len(raw),
                'characters': len(markdown) - start,
                'sha256': hashlib.sha256(raw).hexdigest(),
                'sections': [{'title': 'Details', 'level': 2, 'path': [title, 'Details'],
                              'start_char': start, 'start_line': 2,
                              'end_char': len(markdown), 'end_line': 4}],
                'unknown_templates': {},
                'omitted_visuals': 0,
            }
            (language_root / article['markdown_path']).write_text(markdown, encoding='utf-8', newline='')
            catalog_entries.append(article)
        catalog = {
            'schema_version': 1,
            'source': 'wikivoyage',
            'language': language,
            'snapshot': '20261001',
            'license': 'CC-BY-SA-4.0',
            'license_url': 'https://creativecommons.org/licenses/by-sa/4.0/',
            'redirects': [],
            'articles': catalog_entries,
        }
        (language_root / 'catalog.json').write_text(
            json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8', newline='',
        )
    library_db = tmp_path / 'library.sqlite3'
    prepare_library(root, library_db, embedding_base_url='https://embedding.example/v1', embedding_model='fixture')
    with LibraryStore(library_db, root) as store:
        uris = {row['language']: row['uri'] for row in store.iter_passages()}
    return root, library_db, uris


def test_fts5_build_is_streamed_contentless_and_records_source_identity(tmp_path, monkeypatch):
    root, library_db, _ = make_library(tmp_path)
    lexical_db = tmp_path / 'lexical.sqlite3'
    with LibraryStore(library_db, root) as store:
        source_manifest_json = store.connection.execute(
            "SELECT value_json FROM manifest WHERE key='manifest'",
        ).fetchone()[0]
        source_manifest_sha256 = hashlib.sha256(source_manifest_json.encode('utf-8')).hexdigest()
        with monkeypatch.context() as patch:
            patch.setattr(Path, 'read_bytes', lambda _path: pytest.fail('lexical build read archived Markdown'))
            manifest = build_library_lexical(store, lexical_db)

    assert manifest['status'] == 'ready'
    assert manifest['algorithm'] == 'fts5-bm25(k1=1.2,b=.75)'
    assert manifest['library_manifest_sha256'] == source_manifest_sha256
    assert manifest['documents_indexed'] == 2
    assert manifest['tokenizer']['version'] == TOKENIZER_VERSION
    assert manifest['contentless_fts5'] is True
    with sqlite3.connect(lexical_db) as connection:
        assert connection.execute('SELECT COUNT(*) FROM documents').fetchone()[0] == 2
        assert connection.execute('SELECT tokens FROM passage_fts LIMIT 1').fetchone()[0] is None

    lexical = LibraryLexical(lexical_db)
    assert lexical.manifest == manifest
    assert lexical.search('栈桥', document_uris=[]) == []


def test_fts5_search_quotes_literal_tokens_and_filters_before_limit(tmp_path):
    root, library_db, uris = make_library(tmp_path)
    lexical_db = tmp_path / 'lexical.sqlite3'
    with LibraryStore(library_db, root) as store:
        build_library_lexical(store, lexical_db)

    lexical = LibraryLexical(lexical_db)
    chinese = lexical.search('栈桥', limit=10, document_uris=[uris['zh']])
    assert len(chinese) == 1
    assert chinese[0]['article_uri'] == uris['zh']

    literal = lexical.search('alpha OR * " harbor', limit=10)
    assert any(row['article_uri'] == uris['en'] for row in literal)
    assert lexical.search('*** ???', limit=10) == []
    assert lexical.search('sharedterm', document_uris=[]) == []

    unfiltered = lexical.search('sharedterm', limit=1)
    assert len(unfiltered) == 1
    other_uri = uris['zh'] if unfiltered[0]['article_uri'] == uris['en'] else uris['en']
    filtered = lexical.search('sharedterm', limit=1, document_uris=[other_uri])
    assert len(filtered) == 1
    assert filtered[0]['article_uri'] == other_uri


def test_fts5_builder_refuses_existing_output(tmp_path):
    root, library_db, _ = make_library(tmp_path)
    output = tmp_path / 'existing.sqlite3'
    output.write_bytes(b'keep')
    with LibraryStore(library_db, root) as store:
        with pytest.raises(FileExistsError):
            build_library_lexical(store, output)
    assert output.read_bytes() == b'keep'


def test_lexical_reader_rejects_stale_tokenizer_identity(tmp_path):
    root, library_db, _ = make_library(tmp_path)
    lexical_db = tmp_path / 'lexical.sqlite3'
    with LibraryStore(library_db, root) as store:
        build_library_lexical(store, lexical_db)
    with sqlite3.connect(lexical_db) as connection:
        manifest = json.loads(connection.execute(
            "SELECT value_json FROM manifest WHERE key='manifest'",
        ).fetchone()[0])
        manifest['tokenizer']['source_sha256'] = '0' * 64
        connection.execute(
            "UPDATE manifest SET value_json=? WHERE key='manifest'",
            (json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')) ,),
        )
    with pytest.raises(ValueError, match='algorithm or tokenizer identity'):
        LibraryLexical(lexical_db)
