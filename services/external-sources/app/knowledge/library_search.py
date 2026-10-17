"""Small, scoped retrieval over a prepared library; only candidates enter memory."""
from pathlib import Path
import re
import time

from .corpus import fingerprint
from .library import LibraryStore
from .strategies import fusion


def article_scope(store, document_ids=None, destination=None):
    """Resolve the public MCP scope before recall, preserving exact revisions."""
    if document_ids is None and not destination:
        return None
    if document_ids == []:
        return []
    clauses, values = [], []
    if document_ids is not None:
        uris, legacy = [], []
        for identifier in document_ids:
            if identifier.startswith('guide://'):
                article = store.get_article(identifier)
                if article:
                    uris.append(article['uri'])
            else:
                legacy.append(identifier)
        alternatives = []
        if uris:
            alternatives.append('uri IN (' + ','.join('?' for _ in uris) + ')')
            values.extend(uris)
        if legacy:
            marks = ','.join('?' for _ in legacy)
            alternatives.append(f'(source_url IN ({marks}) OR ((source_url IS NULL OR source_url=\'\') AND title IN ({marks})))')
            values.extend(legacy + legacy)
        if not alternatives:
            return []
        clauses.append('(' + ' OR '.join(alternatives) + ')')
    if destination:
        store.connection.create_function('casefold', 1, str.casefold, deterministic=True)
        clauses.append('instr(casefold(title),?)>0')
        values.append(destination.casefold())
    return [row[0] for row in store.connection.execute(
        'SELECT uri FROM articles WHERE ' + ' AND '.join(clauses) + ' ORDER BY rowid', values)]


def library_blocks(store, ranking, *, limit=5, chars=6000):
    """Return exact original spans under the existing per-search body budget."""
    blocks = []
    for row in ranking[:limit]:
        if chars <= 0:
            break
        passage = store.get_passage(row['id'])
        if passage is None:
            raise ValueError('Recall returned a passage outside the prepared library')
        section = store.connection.execute(
            'SELECT body_start_char,body_end_char FROM sections WHERE section_id=?',
            (passage['section_id'],)).fetchone()
        text = passage['text'][:chars]
        blocks.append({'uri': passage['uri'], 'section_path': passage['section_path'],
                       'range': [passage['range'][0], passage['range'][0] + len(text)],
                       'text': text,
                       'source_url': passage['source_url'],
                       'revision_url': passage['revision_url'],
                       'license': passage['license'],
                       'section_coverage': len(text) / max(1, section['body_end_char'] - section['body_start_char'])})
        templates = sorted(set(re.findall(r'【模板 ([^】]+)】', text)))
        if templates:
            blocks[-1]['unexpanded_templates'] = templates
        chars -= len(text)
    return blocks


class LibrarySearch:
    """Inject the query embedder so offline evaluation cannot spend implicitly."""
    def __init__(self, database, knowledge_root, *, collection=None, qdrant=None,
                 embed_query=None, lexical=None, mode='dense', candidates=20,
                 context_chars=6000, exact=False, hnsw_ef=128):
        if mode not in ('dense', 'lexical', 'hybrid'):
            raise ValueError('Unknown library retrieval mode')
        if mode != 'lexical' and (qdrant is None or embed_query is None or collection is None):
            raise ValueError('Dense retrieval requires a collection and query embedder')
        if mode != 'dense' and lexical is None:
            raise ValueError('Lexical retrieval requires a prepared lexical index')
        self.database, self.root = Path(database), Path(knowledge_root)
        self.collection, self.qdrant, self.embed_query = collection, qdrant, embed_query
        self.lexical, self.mode, self.candidates = lexical, mode, candidates
        self.context_chars, self.exact, self.hnsw_ef = context_chars, exact, hnsw_ef
        with LibraryStore(self.database, self.root) as store:
            self.version = fingerprint({'library': fingerprint(store.manifest), 'collection': collection,
                'mode': mode, 'candidates': candidates, 'context_chars': context_chars,
                'exact': exact, 'hnsw_ef': hnsw_ef})[:32]

    async def search(self, query, limit=5, document_ids=None, destination=None):
        with LibraryStore(self.database, self.root) as store:
            scope = article_scope(store, document_ids, destination)
            if scope == []:
                return {'index_version': self.version, 'blocks': []}
            vector = await self.embed_query(query) if self.mode != 'lexical' else None
            started = time.monotonic()
            dense = await self.qdrant.search(vector, collection=self.collection,
                limit=self.candidates, exact=self.exact, hnsw_ef=self.hnsw_ef,
                document_uris=scope) if self.mode != 'lexical' else []
            lexical = self.lexical.search(query, limit=self.candidates,
                document_uris=scope) if self.mode != 'dense' else []
            ranking = fusion(dense, lexical) if self.mode == 'hybrid' else dense if self.mode == 'dense' else lexical
            recall_seconds = time.monotonic() - started
            return {'index_version': self.version,
                    'blocks': library_blocks(store, ranking, limit=limit, chars=self.context_chars),
                    'retrieval': {'mode': self.mode, 'candidate_count': len(ranking),
                                  'recall_seconds': recall_seconds, 'exact': self.exact if vector is not None else None}}
