import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from app.knowledge.corpus import chunk_report, fingerprint, prepare, selected_corpus
from app.knowledge.library import LibraryStore, prepare_library


BASE_URL = 'https://embedding.example/v1'
MODEL = 'test-embed-v1'


def _article(language, title, markdown, sections, *, templates=None, revision='rev-1'):
    raw = markdown.encode('utf-8')
    return {
        'page_id': f'{language}-{title}',
        'title': title,
        'revision_id': revision,
        'revision_timestamp': '2026-10-01T00:00:00Z',
        'source_sha1': 'source-sha1',
        'language': language,
        'source_url': f'https://{language}.wikivoyage.org/wiki/{title}',
        'revision_url': f'https://{language}.wikivoyage.org/w/index.php?oldid={revision}',
        'history_url': f'https://{language}.wikivoyage.org/w/index.php?title={title}&action=history',
        'markdown_path': f'articles/{title}.md',
        'markdown_bytes': len(raw),
        'characters': len(markdown) - (sections[0]['start_char'] if sections else len(markdown)),
        'sha256': hashlib.sha256(raw).hexdigest(),
        'sections': sections,
        'unknown_templates': templates or {},
        'omitted_visuals': 2,
    }


def fixture_library(tmp_path: Path) -> tuple[Path, dict]:
    root = tmp_path / 'knowledge'
    snapshot = root / 'wikivoyage' / '20261001'
    snapshot.mkdir(parents=True)

    markdown_en = '# Test\n## Duplicated\nsame body 𠮷 and emoji 🌄.\n## Duplicated\nsame body 𠮷 and emoji 🌄.\n## Empty\n## References\nReference passage stays in the all-section library.\n'
    first_start = markdown_en.index('## Duplicated')
    second_start = markdown_en.index('## Duplicated', first_start + 1)
    empty_start = markdown_en.index('## Empty')
    references_start = markdown_en.index('## References')
    sections_en = [
        {'title': 'Duplicated', 'level': 2, 'path': ['Test', 'Duplicated'],
         'start_char': first_start, 'start_line': 2,
         'end_char': second_start, 'end_line': 4},
        {'title': 'Duplicated', 'level': 2, 'path': ['Test', 'Duplicated'],
         'start_char': second_start, 'start_line': 4,
         'end_char': empty_start, 'end_line': 6},
        {'title': 'Empty', 'level': 2, 'path': ['Test', 'Empty'],
         'start_char': empty_start, 'start_line': 6,
         'end_char': references_start, 'end_line': 7},
        {'title': 'References', 'level': 2, 'path': ['Test', 'References'],
         'start_char': references_start, 'start_line': 7,
         'end_char': len(markdown_en), 'end_line': 9},
    ]
    markdown_zh = '# 测试 𠮷\n## 出发\n你好，𠮷🌐。\n'
    zh_start = markdown_zh.index('## 出发')
    sections_zh = [{'title': '出发', 'level': 2, 'path': ['测试 𠮷', '出发'],
                    'start_char': zh_start, 'start_line': 2,
                    'end_char': len(markdown_zh), 'end_line': 4}]
    markdown_no_sections = '# Only a prefix before any article section.\n'

    articles = {
        'en': [_article('en', 'Test', markdown_en, sections_en, templates={'odd-template': 1})],
        'zh': [
            _article('zh', '测试 𠮷', markdown_zh, sections_zh),
            _article('zh', 'No sections', markdown_no_sections, []),
        ],
    }
    markdowns = {
        'en': {'Test': markdown_en},
        'zh': {'测试 𠮷': markdown_zh, 'No sections': markdown_no_sections},
    }
    for language, entries in articles.items():
        language_root = snapshot / language
        (language_root / 'articles').mkdir(parents=True)
        for article in entries:
            relative = article['markdown_path']
            (language_root / relative).write_text(
                markdowns[language][article['title']], encoding='utf-8', newline='',
            )
        catalog = {
            'schema_version': 1,
            'source': 'wikivoyage',
            'language': language,
            'snapshot': '20261001',
            'license': 'CC-BY-SA-4.0',
            'license_url': 'https://creativecommons.org/licenses/by-sa/4.0/',
            'redirects': [{'page_id': f'{language}-alias', 'title': 'Old Test', 'redirect': 'Test'}],
            'articles': entries,
        }
        (language_root / 'catalog.json').write_text(
            json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8', newline='',
        )
    return root, articles


def build(tmp_path: Path, root: Path) -> Path:
    database = tmp_path / 'library.sqlite3'
    prepare_library(root, database, embedding_base_url=BASE_URL, embedding_model=MODEL)
    return database


def test_library_preserves_chunk_and_cache_identity_and_reads_exact_unicode(tmp_path):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)

    source_corpus = selected_corpus(
        prepare(root, sample=False, selection={'sources': ['wikivoyage']}), 'all',
    )
    expected = chunk_report(
        source_corpus, size=1200, overlap=120, strategy='recursive', recursive_merge_small=True,
    )['chunks']
    expected_corpus_id = fingerprint({
        'rules': source_corpus['rules'],
        'sections': [(section['id'], fingerprint(section['text']), section['selected'])
                     for section in source_corpus['audit']],
    })[:24]
    expected_keys = {
        passage['id']: fingerprint({'url': BASE_URL, 'model': MODEL, 'text': passage['embedding_text']})
        for passage in expected
    }

    with LibraryStore(database, root) as store:
        assert store.manifest['corpus_id'] == expected_corpus_id
        assert store.manifest['algorithm']['section_rule'] == 'all'
        assert store.counts['articles'] == 3
        assert store.counts['passages'] == len(expected)
        passages = list(store.iter_passages(batch_size=1))
        assert {row['id'] for row in passages} == {row['id'] for row in expected}
        assert {row['id']: row['embedding_key'] for row in passages} == expected_keys

        for passage in expected:
            stored = store.get_passage(passage['id'])
            assert stored is not None
            assert stored['text'] == passage['text']
            assert stored['range'] == [
                passage['start_char'] + passage['section_start'],
                passage['start_char'] + passage['section_end'],
            ]
            assert stored['embedding_key'] == expected_keys[passage['id']]
            article = store.get_article(stored['uri'])
            assert article['version'] == stored['uri'].rsplit('/', 1)[-1]

        en_article = next(row for row in passages if row['language'] == 'en')
        en = store.get_article(en_article['uri'])
        assert en['unknown_templates'] == {'odd-template': 1}
        no_sections_uri = store.connection.execute(
            "SELECT uri FROM articles WHERE title='No sections'",
        ).fetchone()[0]
        assert store.get_article(no_sections_uri)['characters'] == 0
        assert store.connection.execute(
            "SELECT COUNT(*) FROM sections WHERE article_id=(SELECT article_id FROM articles WHERE title='No sections')",
        ).fetchone()[0] == 0
        empty = store.get_section(en_article['uri'], ['Test', 'Empty'])
        assert empty['body_start_char'] == empty['body_end_char']
        assert store.get_section(en_article['uri'], ['missing']) is None

        en_passages = [row for row in passages if row['language'] == 'en']
        assert len(en_passages) == 3
        duplicate_rows = [row for row in en_passages if row['section_path'] == ['Test', 'Duplicated']]
        assert len(duplicate_rows) == 2
        assert duplicate_rows[0]['embedding_key'] == duplicate_rows[1]['embedding_key']
        assert sum(1 for row in store.iter_embedding_inputs() if row['key'] == duplicate_rows[0]['embedding_key']) == 1
        references = store.get_section(en_article['uri'], ['Test', 'References'])
        assert references['selected'] is True
        assert references['reason'] == 'selected-article-body'
        reference_passage = next(row for row in en_passages if row['section_path'][1] == 'References')
        assert 'Reference passage stays' in store.get_passage(reference_passage['id'])['text']
        alias = store.connection.execute(
            'SELECT language,title,target,target_exists FROM aliases WHERE language=?', ('en',),
        ).fetchone()
        assert tuple(alias) == ('en', 'Old Test', 'Test', 1)


@pytest.mark.parametrize('failure', ['sha', 'range'])
def test_library_rejects_bad_source_sha_or_unicode_range_without_publishing(tmp_path, failure):
    root, _ = fixture_library(tmp_path)
    catalog_path = root / 'wikivoyage' / '20261001' / 'en' / 'catalog.json'
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    if failure == 'sha':
        catalog['articles'][0]['sha256'] = '0' * 64
    else:
        catalog['articles'][0]['sections'][0]['start_char'] = -1
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8')
    output = tmp_path / 'bad.sqlite3'

    with pytest.raises(ValueError):
        prepare_library(root, output, embedding_base_url=BASE_URL, embedding_model=MODEL)

    assert not output.exists()
    staging = output.with_name(output.name + '.building')
    assert staging.exists()
    with sqlite3.connect(staging) as connection:
        manifest = json.loads(connection.execute(
            "SELECT value_json FROM manifest WHERE key='manifest'",
        ).fetchone()[0])
    assert manifest['status'] == 'failed'
    assert manifest['error_type'] == 'ValueError'
    assert 'partial_counts' in manifest
    assert 'error_message' not in manifest


def test_library_uri_lookup_accepts_chinese_iri_but_keeps_version_exact(tmp_path):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)

    with LibraryStore(database, root) as store:
        encoded = next(row for row in store.iter_passages() if row['language'] == 'zh')['uri']
        version = encoded.rsplit('/', 1)[-1]
        iri = f'guide://wikivoyage/zh/测试 𠮷/{version}'
        assert store.get_article(iri) == store.get_article(encoded)
        assert store.get_section(iri, ['测试 𠮷', '出发']) == store.get_section(encoded, ['测试 𠮷', '出发'])
        wrong_version = iri.rsplit('/', 1)[0] + '/' + ('0' * 64)
        assert store.get_article(wrong_version) is None
        assert store.get_section(wrong_version, ['测试 𠮷', '出发']) is None


def test_library_refuses_to_replace_existing_output(tmp_path):
    root, _ = fixture_library(tmp_path)
    output = tmp_path / 'already.sqlite3'
    output.write_bytes(b'keep')

    with pytest.raises(FileExistsError):
        prepare_library(root, output, embedding_base_url=BASE_URL, embedding_model=MODEL)

    assert output.read_bytes() == b'keep'
