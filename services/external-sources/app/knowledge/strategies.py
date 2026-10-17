"""Deterministic retrieval strategies; scores keep their algorithm's native meaning."""
from collections import Counter
import math

from .text import tokenize

VERSION = 'retrieval-strategies-v2'


def similarity(left, right, metric='cosine'):
    if len(left) != len(right):
        raise ValueError('Vector dimension mismatch')
    if metric == 'dot':
        return sum(a*b for a,b in zip(left,right))
    if metric == 'euclidean':
        return -math.sqrt(sum((a-b)**2 for a,b in zip(left,right)))
    norm = math.sqrt(sum(a*a for a in left)*sum(b*b for b in right))
    return sum(a*b for a,b in zip(left,right))/norm if norm else 0.0


def lexical(query, passages, algorithm='bm25', k1=1.5, b=.75):
    documents = [Counter(tokenize(p['embedding_text'])) for p in passages]
    df = Counter(term for doc in documents for term in doc)
    n = len(documents)
    average = sum(sum(doc.values()) for doc in documents)/max(n,1) or 1
    terms = Counter(tokenize(query))
    idf = {term:math.log((n+1)/(df[term]+1))+1 for term in df}
    query_weights = {term:count*idf.get(term,0) for term,count in terms.items()}
    query_norm = math.sqrt(sum(x*x for x in query_weights.values()))
    rows = []
    for passage, words in zip(passages,documents):
        if algorithm == 'tfidf':
            weights = {term:count*idf[term] for term,count in words.items()}
            norm = math.sqrt(sum(x*x for x in weights.values()))*query_norm
            score = sum(weights.get(t,0)*w for t,w in query_weights.items())/norm if norm else 0
        else:
            length = sum(words.values())
            score = sum(math.log(1+(n-df[t]+.5)/(df[t]+.5))*words[t]*(k1+1)/
                        (words[t]+k1*(1-b+b*length/average)) for t in terms if words[t])
        if score > 0:
            rows.append({'id':passage['id'],'score':score})
    return sorted(rows,key=lambda x:(-x['score'],x['id']))


def fusion(dense, lexical, algorithm='rrf', k=60, dense_weight=1, lexical_weight=1):
    scores = {}
    for rows, weight in ((dense,dense_weight),(lexical,lexical_weight)):
        values = [r['score'] for r in rows]
        mean = sum(values)/len(values) if values else 0
        deviation = math.sqrt(sum((x-mean)**2 for x in values)/(len(values)-1)) if len(values)>1 else 0
        for rank,row in enumerate(rows,1):
            if algorithm == 'dbsf':
                value = (row['score']-mean+3*deviation)/(6*deviation) if deviation else .5
            else:
                value = 1/(k+rank)
            scores[row['id']] = scores.get(row['id'],0)+value*(1 if algorithm=='rrf' else weight)
    return sorted([{'id':key,'score':value} for key,value in scores.items()],key=lambda x:(-x['score'],x['id']))


def mmr(ranking, vectors, query_vector, weight=.7, limit=10):
    """Use current ranking's min-max relevance, so reranking is not discarded."""
    remaining = list(ranking); selected = []
    low=min((p['score'] for p in ranking),default=0);high=max((p['score'] for p in ranking),default=0)
    relevance={p['id']:(p['score']-low)/(high-low) if high>low else 1.0 for p in ranking}
    while remaining and len(selected)<limit:
        def criterion(item):
            redundancy = max((similarity(vectors[item['id']],vectors[s['id']]) for s in selected),default=0)
            return weight*relevance[item['id']]-(1-weight)*redundancy
        best = max(remaining,key=criterion)
        selected.append({**best,'mmr_score':criterion(best),'relevance_normalized':relevance[best['id']]})
        remaining.remove(best)
    return selected


def context_material(ranking, passages, sections, strategy='chapters', limit=3, chars=12000, neighbors=1):
    lookup = {p['id']:p for p in passages}; source = {s['id']:s for s in sections}
    grouped = {}
    for p in passages:
        grouped.setdefault(p['section_id'],[]).append(p)
    for rows in grouped.values():
        rows.sort(key=lambda p:p.get('offset',0))
    seen = set(); output = []
    for item in ranking:
        passage = lookup[item['id']]; sid = passage['section_id']
        key = sid if strategy in ('chapters','compress') else passage['id']
        if key in seen: continue
        seen.add(key)
        record = dict(source[sid])
        if strategy == 'chunks':
            value = passage['text']; record['chunk_ids'] = [passage['id']]
        elif strategy == 'neighbors':
            rows = grouped[sid]; pos = next(i for i,p in enumerate(rows) if p['id']==passage['id'])
            selected = rows[max(0,pos-neighbors):pos+neighbors+1]
            # Use source ranges to avoid repeating overlapping text.
            start = min(p['section_start'] for p in selected); end = max(p['section_end'] for p in selected)
            value = record['text'][start:end]; record['chunk_ids'] = [p['id'] for p in selected]
        else:
            value = record['text']
        record.update(text=value[:chars],context_truncated=len(value)>chars,context_strategy=strategy)
        output.append(record); chars -= len(record['text'])
        if len(output)>=limit or chars<=0: break
    return output
