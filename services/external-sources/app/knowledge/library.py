"""Offline, immutable SQLite catalog of versioned Wikivoyage passages."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Sequence
from urllib.parse import unquote, urlsplit

from .archive import article_uri
from .corpus import (
    RECURSIVE_VERSION,
    RULE_VERSION,
    article_kind,
    catalogs,
    chunk_report,
    content_range,
    fingerprint,
    iter_articles,
)

SCHEMA_VERSION = 1
CHUNK_SIZE = 1200
CHUNK_OVERLAP = 120
CHUNK_STRATEGY = 'recursive'
CHUNK_MERGE_SMALL = True
PREPARER_CACHE_KIB = 64 * 1024


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _catalog_header(path: Path) -> dict:
    with path.open(encoding='utf-8', newline='') as source:
        prefix = source.read(16384)
    header = {}
    for key in ('source', 'language', 'snapshot', 'license', 'license_url'):
        match = re.search(
            r'^  "' + re.escape(key) + r'"\s*:\s*("(?:\\.|[^"\\])*")',
            prefix, re.MULTILINE,
        )
        if match:
            header[key] = json.loads(match.group(1))
    return header


def _iter_catalog_array(path: Path, name: str) -> Iterator[dict]:
    """Stream one top-level array without materializing the catalog JSON."""
    decoder = json.JSONDecoder()
    buffer = ''
    started = False
    marker = re.compile(r'"' + re.escape(name) + r'"\s*:\s*\[')
    with path.open(encoding='utf-8', newline='') as source:
        while True:
            chunk = source.read(65536)
            if not chunk and not buffer.strip():
                break
            buffer += chunk
            if not started:
                match = marker.search(buffer)
                if not match:
                    if not chunk:
                        raise ValueError(f'Catalog has no {name} array: {path}')
                    continue
                buffer = buffer[match.end():]
                started = True
            while True:
                buffer = buffer.lstrip(' \t\r\n,')
                if buffer.startswith(']'):
                    return
                try:
                    value, end = decoder.raw_decode(buffer)
                except ValueError:
                    if not chunk:
                        raise ValueError(f'Incomplete {name} array: {path}')
                    break
                if not isinstance(value, dict):
                    raise ValueError(f'Catalog {name} entries must be objects: {path}')
                yield value
                buffer = buffer[end:]


def _catalog_set(knowledge_root: Path) -> list[tuple[str, str, Path]]:
    found = [(source, language, Path(catalog).resolve())
             for source, language, catalog in catalogs(knowledge_root)
             if source == 'wikivoyage' and language in ('en', 'zh')]
    by_language = {language: (source, language, path) for source, language, path in found}
    if set(by_language) != {'en', 'zh'}:
        raise ValueError('A complete Wikivoyage en/zh catalog pair is required')
    snapshots = {path.parent.parent.name for _, _, path in found}
    if len(snapshots) != 1:
        raise ValueError('Wikivoyage catalogs must use the same snapshot')
    return [by_language[language] for language in ('en', 'zh')]


def _canonical_uri(uri: str) -> str | None:
    parsed = urlsplit(uri)
    parts = parsed.path.lstrip('/').split('/')
    if parsed.scheme.lower() != 'guide' or parsed.query or parsed.fragment or len(parts) != 3:
        return None
    source = unquote(parsed.netloc)
    language, title, version = (unquote(part) for part in parts)
    if not source or not language or not title or not version:
        return None
    return article_uri(source, language, title, version)


def _partial_counts(connection: sqlite3.Connection) -> dict:
    counts = {
        'articles': connection.execute('SELECT COUNT(*) FROM articles').fetchone()[0],
        'sections': connection.execute('SELECT COUNT(*) FROM sections').fetchone()[0],
        'selected_sections': connection.execute('SELECT COUNT(*) FROM sections WHERE selected=1').fetchone()[0],
        'passages': connection.execute('SELECT COUNT(*) FROM passages').fetchone()[0],
        'aliases': connection.execute('SELECT COUNT(*) FROM aliases').fetchone()[0],
        'unique_embedding_inputs': connection.execute('SELECT COUNT(*) FROM embedding_inputs').fetchone()[0],
        'source_markdown_bytes': connection.execute('SELECT COALESCE(SUM(markdown_bytes),0) FROM articles').fetchone()[0],
        'source_characters': connection.execute('SELECT COALESCE(SUM(markdown_characters),0) FROM articles').fetchone()[0],
    }
    counts['by_language'] = {}
    for language in ('en', 'zh'):
        row = connection.execute('''SELECT COUNT(*) AS articles,
            COALESCE(SUM(section_count),0) AS sections,
            COALESCE(SUM(selected_section_count),0) AS selected_sections,
            COALESCE(SUM(passage_count),0) AS passages,
            COALESCE(SUM(markdown_bytes),0) AS source_markdown_bytes,
            COALESCE(SUM(markdown_characters),0) AS source_characters
            FROM articles WHERE language=?''', (language,)).fetchone()
        aliases = connection.execute('SELECT COUNT(*) FROM aliases WHERE language=?', (language,)).fetchone()[0]
        counts['by_language'][language] = {**dict(row), 'aliases': aliases}
    return counts


def _schema(connection: sqlite3.Connection) -> None:
    connection.executescript('''
        PRAGMA foreign_keys = ON;
        CREATE TABLE manifest (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );
        CREATE TABLE articles (
            article_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            language TEXT NOT NULL,
            title TEXT NOT NULL,
            version TEXT NOT NULL,
            uri TEXT NOT NULL UNIQUE,
            relative_file TEXT NOT NULL,
            page_id TEXT,
            revision TEXT,
            revision_timestamp TEXT,
            source_sha1 TEXT,
            source_url TEXT,
            revision_url TEXT,
            history_url TEXT,
            license TEXT,
            license_url TEXT,
            markdown_bytes INTEGER NOT NULL,
            characters INTEGER NOT NULL,
            markdown_characters INTEGER NOT NULL,
            unknown_templates_json TEXT NOT NULL,
            omitted_visuals INTEGER,
            section_count INTEGER NOT NULL,
            selected_section_count INTEGER NOT NULL,
            passage_count INTEGER NOT NULL
        );
        CREATE INDEX articles_title ON articles(source, language, title);
        CREATE TABLE aliases (
            alias_id INTEGER PRIMARY KEY,
            source TEXT NOT NULL,
            language TEXT NOT NULL,
            title TEXT NOT NULL,
            target TEXT NOT NULL,
            page_id TEXT,
            raw_json TEXT NOT NULL,
            target_exists INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX aliases_title ON aliases(source, language, title);
        CREATE INDEX aliases_target ON aliases(source, language, target);
        CREATE TABLE sections (
            section_id TEXT PRIMARY KEY,
            article_id TEXT NOT NULL REFERENCES articles(article_id),
            ordinal INTEGER NOT NULL,
            title TEXT NOT NULL,
            level INTEGER,
            path_json TEXT NOT NULL,
            start_char INTEGER NOT NULL,
            end_char INTEGER NOT NULL,
            body_start_char INTEGER NOT NULL,
            body_end_char INTEGER NOT NULL,
            selected INTEGER NOT NULL,
            reason TEXT NOT NULL,
            text_sha256 TEXT NOT NULL
        );
        CREATE INDEX sections_article_path ON sections(article_id, path_json, start_char);
        CREATE TABLE embedding_inputs (
            key TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            text_sha256 TEXT NOT NULL,
            chars INTEGER NOT NULL
        );
        CREATE TABLE passages (
            chunk_id TEXT PRIMARY KEY,
            article_id TEXT NOT NULL REFERENCES articles(article_id),
            section_id TEXT NOT NULL REFERENCES sections(section_id),
            ordinal INTEGER NOT NULL,
            offset_chars INTEGER NOT NULL,
            start_char INTEGER NOT NULL,
            end_char INTEGER NOT NULL,
            text_sha256 TEXT NOT NULL,
            embedding_key TEXT NOT NULL REFERENCES embedding_inputs(key),
            embedding_text_sha256 TEXT NOT NULL,
            embedding_chars INTEGER NOT NULL,
            chunk_strategy TEXT NOT NULL,
            end_boundary TEXT,
            structure_units INTEGER
        );
        CREATE INDEX passages_article ON passages(article_id, start_char);
        CREATE INDEX passages_embedding ON passages(embedding_key);
    ''')


def _body_absolute_range(section_text: str, section_start: int) -> tuple[int, int]:
    start, end = content_range({'text': section_text})
    # Heading-only sections can have an origin after their stripped final newline.
    end = max(start, end)
    return section_start + start, section_start + end


def _covered_chars(start: int, end: int, intervals: list[tuple[int, int]]) -> tuple[int, int]:
    if end <= start:
        return 0, 0
    merged = 0
    cursor = start
    gaps = 0
    for left, right in sorted(intervals):
        left = max(start, left)
        right = min(end, right)
        if right <= left:
            continue
        if left > cursor:
            gaps += 1
        if right > cursor:
            merged += right - max(cursor, left)
            cursor = right
    if cursor < end:
        gaps += 1
    return merged, gaps


def _insert_embedding_input(connection: sqlite3.Connection, key: str, text: str) -> tuple[str, int]:
    text_sha = hashlib.sha256(text.encode('utf-8')).hexdigest()
    chars = len(text)
    row = connection.execute('SELECT text_sha256, chars FROM embedding_inputs WHERE key=?', (key,)).fetchone()
    if row is not None:
        if tuple(row) != (text_sha, chars):
            raise ValueError(f'Embedding key collision: {key}')
        return text_sha, chars
    connection.execute(
        'INSERT INTO embedding_inputs(key,text,text_sha256,chars) VALUES(?,?,?,?)',
        (key, text, text_sha, chars),
    )
    return text_sha, chars


def prepare_library(
    knowledge_root: str | Path,
    output_path: str | Path,
    *,
    embedding_base_url: str,
    embedding_model: str,
) -> dict:
    """Build a sealed SQLite library locally; no embedding or network work occurs."""
    root = Path(knowledge_root).resolve()
    output = Path(output_path).resolve()
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.with_name(output.name + '.building')
    if staging.exists():
        raise FileExistsError(staging)

    selected_catalogs = _catalog_set(root)
    snapshot = selected_catalogs[0][2].parent.parent.name
    catalog_hashes = {language: _sha256_file(path) for _, language, path in selected_catalogs}
    initial_manifest = {
        'schema_version': SCHEMA_VERSION,
        'status': 'building',
        'source': 'wikivoyage',
        'snapshot': snapshot,
        'languages': ['en', 'zh'],
        'catalog_sha256': catalog_hashes,
        'algorithm': {
            'section_rules': RULE_VERSION,
            'section_rule': 'all',
            'recursive_version': RECURSIVE_VERSION,
            'chunk_strategy': CHUNK_STRATEGY,
            'chunk_chars': CHUNK_SIZE,
            'overlap_chars': CHUNK_OVERLAP,
            'recursive_merge_small': CHUNK_MERGE_SMALL,
        },
        'storage': {'sqlite_page_cache_kib': PREPARER_CACHE_KIB},
        'embedding': {'base_url': embedding_base_url, 'model': embedding_model},
    }
    db = sqlite3.connect(staging)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA journal_mode = DELETE')
        db.execute('PRAGMA synchronous = NORMAL')
        db.execute(f'PRAGMA cache_size = -{PREPARER_CACHE_KIB}')
        _schema(db)
        db.execute('BEGIN')

        counts = Counter()
        counts_by_language: dict[str, Counter] = {'en': Counter(), 'zh': Counter()}
        corpus_digest = hashlib.sha256()
        corpus_digest.update(b'{"rules":')
        corpus_digest.update(_json(RULE_VERSION).encode('utf-8'))
        corpus_digest.update(b',"sections":[')
        first_identity = True

        db.execute('INSERT INTO manifest(key,value_json) VALUES(?,?)', ('manifest', _json(initial_manifest)))
        db.commit()

        for source, language, catalog in selected_catalogs:
            catalog_header = _catalog_header(catalog)
            if (catalog_header.get('source') != source
                    or catalog_header.get('language') != language
                    or catalog_header.get('snapshot') != snapshot):
                raise ValueError(f'Catalog identity does not match its Wikivoyage path: {catalog}')
            for redirect in _iter_catalog_array(catalog, 'redirects'):
                title = redirect.get('title')
                target = redirect.get('target', redirect.get('redirect'))
                if not isinstance(title, str) or not isinstance(target, str):
                    raise ValueError(f'Invalid {language} redirect record in {catalog}')
                db.execute(
                    'INSERT INTO aliases(source,language,title,target,page_id,raw_json) VALUES(?,?,?,?,?,?)',
                    (source, language, title, target, redirect.get('page_id'), _json(redirect)),
                )
                counts['aliases'] += 1
                counts_by_language[language]['aliases'] += 1

            for article in iter_articles(catalog):
                title = article.get('title')
                actual_language = article.get('language') or language
                if not isinstance(title, str) or not title or actual_language != language:
                    raise ValueError(f'Invalid {language} Wikivoyage article metadata in {catalog}')
                article_path = (catalog.parent / article['markdown_path']).resolve()
                if not article_path.is_relative_to(catalog.parent.resolve()):
                    raise ValueError(f'Catalog path leaves snapshot: {title}')
                if not article_path.is_relative_to(root):
                    raise ValueError(f'Article path leaves knowledge root: {title}')
                raw = article_path.read_bytes()
                article_sha = hashlib.sha256(raw).hexdigest()
                if article.get('sha256') and article_sha != article['sha256']:
                    raise ValueError(f'Source checksum changed: {title}')
                if article.get('markdown_bytes') is not None and article['markdown_bytes'] != len(raw):
                    raise ValueError(f'Source byte count changed: {title}')
                markdown = raw.decode('utf-8')
                sections = article.get('sections')
                if not isinstance(sections, list):
                    raise ValueError(f'Article sections are missing: {title}')
                if sections:
                    body_start = sections[0].get('start_char')
                    if not isinstance(body_start, int) or body_start < 0 or body_start > len(markdown):
                        raise ValueError(f'Invalid first Unicode section range in {title}: {body_start}')
                else:
                    body_start = len(markdown)
                if article.get('characters') is not None and article['characters'] != len(markdown) - body_start:
                    raise ValueError(f'Source body character count changed: {title}')

                relative_file = article_path.relative_to(root).as_posix()
                article_id = fingerprint([source, actual_language, title])[:16]
                uri = article_uri(source, actual_language, title, article_sha)
                revision = article.get('revision_id', article.get('revision'))
                db.execute('''INSERT INTO articles(
                    article_id,source,language,title,version,uri,relative_file,page_id,revision,
                    revision_timestamp,source_sha1,source_url,revision_url,history_url,license,
                    license_url,markdown_bytes,characters,markdown_characters,unknown_templates_json,omitted_visuals,
                    section_count,selected_section_count,passage_count
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                    article_id, source, actual_language, title, article_sha, uri, relative_file,
                    article.get('page_id'), revision, article.get('revision_timestamp'),
                    article.get('source_sha1'), article.get('source_url', article.get('url')),
                    article.get('revision_url'), article.get('history_url'),
                    article.get('license', catalog_header.get('license', 'CC-BY-SA-4.0')),
                    article.get('license_url', catalog_header.get(
                        'license_url', 'https://creativecommons.org/licenses/by-sa/4.0/')),
                    len(raw), article.get('characters', len(markdown) - body_start), len(markdown),
                    _json(article.get('unknown_templates') or {}),
                    article.get('omitted_visuals'), len(sections), 0, 0,
                ))

                selected_sections = []
                body_ranges: dict[str, tuple[int, int]] = {}
                section_intervals: dict[str, list[tuple[int, int]]] = {}
                selected_count = 0
                for ordinal, section in enumerate(sections):
                    start = section.get('start_char')
                    end = section.get('end_char')
                    if (not isinstance(start, int) or not isinstance(end, int)
                            or start < 0 or end < start or end > len(markdown)):
                        raise ValueError(f'Invalid Unicode section range in {title}: {start}:{end}')
                    path = section.get('path')
                    section_title = section.get('title')
                    if not isinstance(path, list) or not path or not all(isinstance(item, str) for item in path):
                        raise ValueError(f'Invalid section path in {title}: {section_title}')
                    if not isinstance(section_title, str):
                        raise ValueError(f'Section title is missing in {title}')
                    section_text = markdown[start:end]
                    selected = bool(section_text.strip())
                    reason = 'selected-article-body'
                    identity = fingerprint({
                        'source': source, 'path': str(article_path), 'revision': revision,
                        'start': start, 'end': end,
                    })
                    body_start, body_end = _body_absolute_range(section_text, start)
                    text_sha = hashlib.sha256(section_text.encode('utf-8')).hexdigest()
                    db.execute('''INSERT INTO sections(
                        section_id,article_id,ordinal,title,level,path_json,start_char,end_char,
                        body_start_char,body_end_char,selected,reason,text_sha256
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                        identity, article_id, ordinal, section_title, section.get('level'),
                        _json(path), start, end, body_start, body_end, int(selected), reason, text_sha,
                    ))
                    if not first_identity:
                        corpus_digest.update(b',')
                    corpus_digest.update(_json([identity, fingerprint(section_text), bool(selected)]).encode('utf-8'))
                    first_identity = False
                    if selected:
                        selected_count += 1
                        body_ranges[identity] = (body_start, body_end)
                        section_intervals[identity] = []
                        selected_sections.append({
                            'id': identity, 'source': source, 'language': actual_language,
                            'article_title': title, 'article_kind': article_kind(article),
                            'path': path, 'selected': True, 'reason': reason,
                            'rule_version': RULE_VERSION, 'source_file': str(article_path),
                            'source_url': article.get('source_url', article.get('url')),
                            'license': article.get('license', 'CC-BY-SA-4.0'),
                            'license_url': article.get('license_url', 'https://creativecommons.org/licenses/by-sa/4.0/'),
                            'revision_url': article.get('revision_url'), 'history_url': article.get('history_url'),
                            'revision': revision, 'start_char': start, 'end_char': end,
                            'text': section_text, 'sha256': article_sha,
                        })

                report = chunk_report(
                    {'sections': selected_sections}, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP,
                    strategy=CHUNK_STRATEGY, recursive_merge_small=CHUNK_MERGE_SMALL,
                )
                passage_count = 0
                passage_ordinals: Counter = Counter()
                selected_by_id = {section['id']: section for section in selected_sections}
                for passage in report['chunks']:
                    section_id = passage['section_id']
                    section = selected_by_id[section_id]
                    absolute_start = section['start_char'] + passage['section_start']
                    absolute_end = section['start_char'] + passage['section_end']
                    original = markdown[absolute_start:absolute_end]
                    if original != passage['text']:
                        raise ValueError(f'Chunk range does not match original text: {title}/{section_id}')
                    if not original.strip():
                        raise ValueError(f'Chunker returned an empty passage: {title}/{section_id}')
                    embedding_key = fingerprint({
                        'url': embedding_base_url, 'model': embedding_model,
                        'text': passage['embedding_text'],
                    })
                    embedding_text_sha, embedding_chars = _insert_embedding_input(
                        db, embedding_key, passage['embedding_text'],
                    )
                    passage_ordinal = passage_ordinals[section_id]
                    passage_ordinals[section_id] += 1
                    text_sha = hashlib.sha256(original.encode('utf-8')).hexdigest()
                    db.execute('''INSERT INTO passages(
                        chunk_id,article_id,section_id,ordinal,offset_chars,start_char,end_char,
                        text_sha256,embedding_key,embedding_text_sha256,embedding_chars,
                        chunk_strategy,end_boundary,structure_units
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                        passage['id'], article_id, section_id, passage_ordinal, passage['offset'],
                        absolute_start, absolute_end, text_sha, embedding_key, embedding_text_sha,
                        embedding_chars, passage['chunk_strategy'], passage.get('end_boundary'),
                        passage.get('structure_units'),
                    ))
                    section_intervals[section_id].append((absolute_start, absolute_end))
                    passage_count += 1

                for section_id, (body_start, body_end) in body_ranges.items():
                    covered, gaps = _covered_chars(body_start, body_end, section_intervals[section_id])
                    if gaps:
                        raise ValueError(f'Chunk coverage has a gap in {title}/{section_id}')
                    counts['selected_body_chars'] += max(0, body_end - body_start)
                    counts['covered_body_chars'] += covered

                db.execute(
                    'UPDATE articles SET selected_section_count=?,passage_count=? WHERE article_id=?',
                    (selected_count, passage_count, article_id),
                )
                counts['articles'] += 1
                counts['sections'] += len(sections)
                counts['selected_sections'] += selected_count
                counts['passages'] += passage_count
                counts['source_markdown_bytes'] += len(raw)
                counts['source_characters'] += len(markdown)
                per_language = counts_by_language[language]
                per_language['articles'] += 1
                per_language['sections'] += len(sections)
                per_language['selected_sections'] += selected_count
                per_language['passages'] += passage_count
                per_language['source_markdown_bytes'] += len(raw)
                per_language['source_characters'] += len(markdown)
                if counts['articles'] % 250 == 0:
                    db.commit()
                    db.execute('BEGIN')

        corpus_digest.update(b']}')
        db.execute('''UPDATE aliases SET target_exists=EXISTS(
            SELECT 1 FROM articles
            WHERE articles.source=aliases.source AND articles.language=aliases.language
              AND articles.title=aliases.target
        )''')
        counts['unique_embedding_inputs'] = db.execute('SELECT COUNT(*) FROM embedding_inputs').fetchone()[0]
        aliases_by_language = {
            language: db.execute('SELECT COUNT(*) FROM aliases WHERE language=?', (language,)).fetchone()[0]
            for language in ('en', 'zh')
        }
        manifest = {
            **initial_manifest,
            'status': 'ready',
            'created_at': datetime.now(timezone.utc).isoformat(),
            'corpus_id': corpus_digest.hexdigest()[:24],
            'counts': dict(counts),
            'counts_by_language': {language: dict(value) for language, value in counts_by_language.items()},
            'aliases_by_language': aliases_by_language,
            'coverage': {
                'selected_body_chars': counts['selected_body_chars'],
                'covered_body_chars': counts['covered_body_chars'],
                'gaps': 0,
                'coordinate_unit': 'unicode-code-points',
            },
            'limitations': [
                'Snapshot completeness does not imply every Wikivoyage template was rendered.',
                'unknown_templates are retained as article metadata and do not exclude articles.',
                'Redirect targets are preserved as direct language-local labels; chains are not resolved.',
            ],
        }
        db.execute('UPDATE manifest SET value_json=? WHERE key=?', (_json(manifest), 'manifest'))
        db.commit()
        integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
        if integrity != 'ok':
            raise sqlite3.DatabaseError(f'SQLite integrity check failed: {integrity}')
        if output.exists():
            raise FileExistsError(output)
        db.close()
        db = None
        os.rename(staging, output)
        return manifest
    except Exception as error:
        if db is not None:
            try:
                db.rollback()
                db.execute('SELECT 1 FROM manifest WHERE key=?', ('manifest',)).fetchone()
                failed_manifest = {
                    **initial_manifest,
                    'status': 'failed',
                    'error_type': type(error).__name__,
                    'failed_at': datetime.now(timezone.utc).isoformat(),
                    'partial_counts': _partial_counts(db),
                }
                db.execute('UPDATE manifest SET value_json=? WHERE key=?', (_json(failed_manifest), 'manifest'))
                db.commit()
            except sqlite3.Error:
                db.rollback()
            finally:
                db.close()
        raise


class LibraryStore:
    """Small read-only interface for exact URI/path lookup and passage reads."""

    def __init__(self, database: str | Path, knowledge_root: str | Path):
        self.database = Path(database).resolve()
        self.knowledge_root = Path(knowledge_root).resolve()
        self.connection = sqlite3.connect(self.database.as_uri() + '?mode=ro', uri=True)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute('PRAGMA query_only = ON')
        self.connection.execute(f'PRAGMA cache_size = -{PREPARER_CACHE_KIB}')
        row = self.connection.execute("SELECT value_json FROM manifest WHERE key='manifest'").fetchone()
        if row is None:
            self.connection.close()
            raise ValueError('Library manifest is missing')
        self.manifest = json.loads(row['value_json'])
        if self.manifest.get('status') != 'ready':
            self.connection.close()
            raise ValueError('Library is not ready')

    @property
    def counts(self) -> dict:
        return dict(self.manifest.get('counts', {}))

    def _article_dict(self, row: sqlite3.Row) -> dict:
        result = dict(row)
        result['unknown_templates'] = json.loads(result.pop('unknown_templates_json'))
        return result

    def get_article(self, uri: str) -> dict | None:
        canonical = _canonical_uri(uri)
        if canonical is None:
            return None
        row = self.connection.execute('SELECT * FROM articles WHERE uri=?', (canonical,)).fetchone()
        return self._article_dict(row) if row else None

    def get_section(self, uri: str, section_path: Sequence[str]) -> dict | None:
        article = self.get_article(uri)
        if article is None:
            return None
        row = self.connection.execute(
            'SELECT * FROM sections WHERE article_id=? AND path_json=? ORDER BY start_char LIMIT 1',
            (article['article_id'], _json(list(section_path))),
        ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result['path'] = json.loads(result.pop('path_json'))
        result['selected'] = bool(result['selected'])
        return result

    def iter_embedding_inputs(self, batch_size: int = 256) -> Iterator[dict]:
        # Insertion order follows the catalog/chunks; SHA ordering causes random
        # table-page reads across the complete embedding text corpus.
        cursor = self.connection.execute('SELECT key,text,text_sha256,chars FROM embedding_inputs ORDER BY rowid')
        while rows := cursor.fetchmany(batch_size):
            for row in rows:
                yield dict(row)

    def iter_passages(self, batch_size: int = 256) -> Iterator[dict]:
        cursor = self.connection.execute('''SELECT p.chunk_id AS id,p.article_id,p.section_id,
            p.ordinal,p.offset_chars,p.start_char,p.end_char,p.text_sha256,p.embedding_key,
            p.embedding_text_sha256,p.embedding_chars,p.chunk_strategy,p.end_boundary,p.structure_units,
            a.source,a.language,a.title,a.uri,a.version,a.revision,a.revision_timestamp,
            a.source_url,a.revision_url,a.history_url,a.license,a.license_url,
            s.start_char AS section_base_char,s.path_json
            FROM passages p JOIN articles a ON a.article_id=p.article_id
            JOIN sections s ON s.section_id=p.section_id ORDER BY p.rowid''')
        while rows := cursor.fetchmany(batch_size):
            for row in rows:
                result = dict(row)
                result['section_path'] = json.loads(result.pop('path_json'))
                result['article_title'] = result['title']
                result['path'] = result['section_path']
                result['sha256'] = result['version']
                result['offset'] = result['offset_chars']
                result['section_start'] = result['start_char'] - result['section_base_char']
                result['section_end'] = result['end_char'] - result['section_base_char']
                result['range'] = [result['start_char'], result['end_char']]
                result.pop('section_base_char')
                yield result

    def get_passage(self, chunk_id: str) -> dict | None:
        row = self.connection.execute('''SELECT p.*,a.source,a.language,a.title,a.uri,
            a.relative_file,a.version,a.revision,a.revision_timestamp,a.source_url,a.revision_url,
            a.history_url,a.license,a.license_url,s.start_char AS section_base_char,s.path_json,
            e.text AS embedding_text FROM passages p
            JOIN articles a ON a.article_id=p.article_id
            JOIN sections s ON s.section_id=p.section_id
            JOIN embedding_inputs e ON e.key=p.embedding_key WHERE p.chunk_id=?''', (chunk_id,)).fetchone()
        if row is None:
            return None
        relative_file = Path(row['relative_file'])
        path = (self.knowledge_root / relative_file).resolve()
        if not path.is_relative_to(self.knowledge_root):
            raise ValueError('Library article path leaves knowledge root')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != row['version']:
            raise ValueError('Archived article version changed')
        markdown = raw.decode('utf-8')
        start, end = row['start_char'], row['end_char']
        if start < 0 or end < start or end > len(markdown):
            raise ValueError('Stored passage range is invalid')
        text = markdown[start:end]
        if hashlib.sha256(text.encode('utf-8')).hexdigest() != row['text_sha256']:
            raise ValueError('Stored passage text changed')
        result = dict(row)
        result['section_path'] = json.loads(result.pop('path_json'))
        result['text'] = text
        result['id'] = result['chunk_id']
        result['article_title'] = result['title']
        result['path'] = result['section_path']
        result['offset'] = result['offset_chars']
        result['section_start'] = start - result['section_base_char']
        result['section_end'] = end - result['section_base_char']
        result['sha256'] = result['version']
        result['start_char'] = result['section_base_char']
        result['range'] = [start, end]
        result.pop('relative_file')
        result.pop('section_base_char')
        return result

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> 'LibraryStore':
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()
