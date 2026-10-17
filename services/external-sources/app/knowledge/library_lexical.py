"""Offline contentless FTS5 baseline for a prepared library database."""
from __future__ import annotations

import hashlib
import inspect
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .library import LibraryStore, _json
from .text import tokenize

SCHEMA_VERSION = 1
ALGORITHM = 'fts5-bm25(k1=1.2,b=.75)'
TOKENIZER_VERSION = 'knowledge-text-tokenize-v1'
BUILD_BATCH_SIZE = 512
COMMIT_EVERY = 8192


def _tokenizer_identity() -> dict:
    source = inspect.getsource(tokenize).encode('utf-8')
    return {
        'name': 'app.knowledge.text.tokenize',
        'version': TOKENIZER_VERSION,
        'source_sha256': hashlib.sha256(source).hexdigest(),
        'fts_tokenizer': 'unicode61',
    }


def _manifest_row(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT value_json FROM manifest WHERE key='manifest'").fetchone()
    if row is None:
        raise ValueError('Library manifest is missing')
    return json.loads(row[0]), row[0]


def build_library_lexical(store: LibraryStore, output_path: str | Path) -> dict:
    """Stream passage embedding inputs into a new SQLite FTS5 index."""
    output = Path(output_path).resolve()
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.with_name(output.name + '.building')
    if staging.exists():
        raise FileExistsError(staging)

    library_manifest, library_manifest_json = _manifest_row(store.connection)
    if library_manifest.get('status') != 'ready':
        raise ValueError('Source library is not ready')
    library_manifest_sha256 = hashlib.sha256(library_manifest_json.encode('utf-8')).hexdigest()
    source_counts = library_manifest.get('counts', {})
    manifest = {
        'schema_version': SCHEMA_VERSION,
        'status': 'building',
        'algorithm': ALGORITHM,
        'algorithm_parameters': {'k1': 1.2, 'b': 0.75, 'score_order': 'ascending'},
        'tokenizer': _tokenizer_identity(),
        'library_manifest_sha256': library_manifest_sha256,
        'source_library': {
            'source': library_manifest.get('source'),
            'snapshot': library_manifest.get('snapshot'),
            'corpus_id': library_manifest.get('corpus_id'),
            'catalog_sha256': library_manifest.get('catalog_sha256'),
            'passage_count': source_counts.get('passages'),
            'unique_embedding_inputs': source_counts.get('unique_embedding_inputs'),
        },
    }
    db = sqlite3.connect(staging)
    indexed = 0
    try:
        db.execute('PRAGMA journal_mode = DELETE')
        db.execute('PRAGMA synchronous = NORMAL')
        db.executescript('''
            CREATE TABLE manifest (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
            CREATE TABLE documents (
                rowid INTEGER PRIMARY KEY,
                chunk_id TEXT NOT NULL UNIQUE,
                article_uri TEXT NOT NULL
            );
            CREATE INDEX documents_article_uri ON documents(article_uri);
            CREATE VIRTUAL TABLE passage_fts USING fts5(tokens, content='');
        ''')
        db.execute('INSERT INTO manifest(key,value_json) VALUES(?,?)', ('manifest', _json(manifest)))
        db.commit()

        source_rows = store.connection.execute('''SELECT p.chunk_id,a.uri,e.text
            FROM passages p
            JOIN articles a ON a.article_id=p.article_id
            JOIN embedding_inputs e ON e.key=p.embedding_key
            ORDER BY p.rowid''')
        next_rowid = 1
        while rows := source_rows.fetchmany(BUILD_BATCH_SIZE):
            map_rows = []
            fts_rows = []
            for chunk_id, article_uri, embedding_text in rows:
                tokens = ' '.join(tokenize(embedding_text))
                map_rows.append((next_rowid, chunk_id, article_uri))
                fts_rows.append((next_rowid, tokens))
                next_rowid += 1
            db.executemany('INSERT INTO documents(rowid,chunk_id,article_uri) VALUES(?,?,?)', map_rows)
            db.executemany('INSERT INTO passage_fts(rowid,tokens) VALUES(?,?)', fts_rows)
            indexed += len(rows)
            if indexed % COMMIT_EVERY < len(rows):
                db.commit()

        manifest.update({
            'status': 'ready',
            'created_at': datetime.now(timezone.utc).isoformat(),
            'documents_indexed': indexed,
            'contentless_fts5': True,
            'query_semantics': 'OR across individually quoted app.knowledge.text.tokenize tokens',
            'comparison_note': 'SQLite FTS5 BM25 is a separate baseline from the project lexical BM25 implementation.',
        })
        db.execute('UPDATE manifest SET value_json=? WHERE key=?', (_json(manifest), 'manifest'))
        db.commit()
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
                partial = {
                    **manifest,
                    'status': 'failed',
                    'error_type': type(error).__name__,
                    'partial_documents_indexed': db.execute('SELECT COUNT(*) FROM documents').fetchone()[0],
                }
                db.execute('UPDATE manifest SET value_json=? WHERE key=?', (_json(partial), 'manifest'))
                db.commit()
            except sqlite3.Error:
                db.rollback()
            finally:
                db.close()
        raise


class LibraryLexical:
    """Readonly lexical index; each search uses a short-lived connection."""

    def __init__(self, database: str | Path):
        self.database = Path(database).resolve()
        with self._connect() as connection:
            row = connection.execute("SELECT value_json FROM manifest WHERE key='manifest'").fetchone()
        if row is None:
            raise ValueError('Lexical manifest is missing')
        self.manifest = json.loads(row[0])
        if self.manifest.get('status') != 'ready':
            raise ValueError('Lexical index is not ready')
        if (self.manifest.get('schema_version') != SCHEMA_VERSION
                or self.manifest.get('algorithm') != ALGORITHM
                or self.manifest.get('algorithm_parameters') != {
                    'k1': 1.2, 'b': 0.75, 'score_order': 'ascending',
                }
                or self.manifest.get('tokenizer') != _tokenizer_identity()):
            raise ValueError('Lexical index algorithm or tokenizer identity is incompatible')

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.database.as_uri() + '?mode=ro', uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only = ON')
        try:
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _match_query(query: str) -> str:
        tokens = dict.fromkeys(tokenize(query))
        return ' OR '.join('"' + token.replace('"', '""') + '"' for token in tokens)

    def search(self, query: str, limit: int = 20, document_uris=None) -> list[dict]:
        if document_uris is not None:
            document_uris = tuple(document_uris)
            if not document_uris:
                return []
        match_query = self._match_query(query)
        if not match_query:
            return []
        sql = '''SELECT d.chunk_id AS id,d.article_uri,bm25(passage_fts) AS score
                 FROM passage_fts JOIN documents d ON d.rowid=passage_fts.rowid
                 WHERE passage_fts MATCH ?'''
        values = [match_query]
        if document_uris is not None:
            placeholders = ','.join('?' for _ in document_uris)
            sql += f' AND d.article_uri IN ({placeholders})'
            values.extend(document_uris)
        sql += ' ORDER BY score ASC,d.chunk_id ASC LIMIT ?'
        values.append(limit)
        with self._connect() as connection:
            rows = connection.execute(sql, values).fetchall()
        return [{'id': row['id'], 'article_uri': row['article_uri'], 'score': row['score']}
                for row in rows]
