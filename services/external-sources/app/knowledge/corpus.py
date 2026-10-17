"""Deterministic section selection; original archives are never rewritten."""
import hashlib
from collections import Counter
import json
from pathlib import Path
import re

RULE_VERSION = 'travel-sections-v1'
RECURSIVE_VERSION = 'chapter-recursive-v3'
SAMPLE_TITLES = {'paris','london','kyoto','qingdao','beijing','new york city','singapore','istanbul',
                 '巴黎','伦敦','倫敦','京都','京都市','青岛','青島','青岛市','北京','北京市','纽约','紐約','新加坡','伊斯坦布尔'}
OMIT = re.compile(r'参考|參考|外部链接|外部連結|注释|註釋|相关条目|相關條目|references|external links|bibliography|further reading|footnotes',re.I)
NON_TRAVEL = re.compile(r'政[治法]|行政区划|行政區劃|财政|財政|人口|经济|經濟|产业|產業|选举|選舉|教育|卫生|衛生|通史|历代|歷代|politic|demograph|population|econom|government|administrative|education|healthcare|industry',re.I)
PRACTICAL = re.compile(r'地理|位置|气候|氣候|交通|铁路|鐵路|车站|車站|航空|机场|機場|旅游|旅遊|景点|景點|饮食|飲食|美食|民俗|节庆|節慶|礼仪|禮儀|观光|觀光|地形|geograph|location|climate|transport|rail|airport|touris|attraction|cuisine|food|festival|customs|etiquette|visitor|access',re.I)
ATTRACTION = re.compile(r'历史|歷史|建筑|建築|藏品|收藏|展览|展覽|展品|生态|生態|特色|地质|地質|动植物|動植物|heritage|history|architectur|collection|exhibit|ecolog|geolog|flora|fauna|feature|design|conservation',re.I)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def iter_articles(path):
    """Stream large catalogs without loading 650k section records into memory."""
    decoder = json.JSONDecoder(); buffer = ''; started = False
    with Path(path).open(encoding='utf-8') as source:
        while True:
            chunk = source.read(65536)
            if not chunk and not buffer.strip(): break
            buffer += chunk
            if not started:
                marker = re.search(r'"articles"\s*:\s*\[',buffer)
                if not marker:
                    if not chunk: raise ValueError('Catalog has no articles')
                    continue
                buffer = buffer[marker.end():]; started = True
            while True:
                buffer = buffer.lstrip(' \t\r\n,')
                if buffer.startswith(']'): return
                try: value,end = decoder.raw_decode(buffer)
                except ValueError:
                    if not chunk: raise ValueError('Incomplete article catalog')
                    break
                yield value; buffer=buffer[end:]


def article_kind(article):
    reasons = article.get('selection_reasons',[])
    if any(reason.get('kind')=='destination' for reason in reasons): return 'destination'
    if any(reason.get('kind')=='tourism_place' for reason in reasons): return 'attraction'
    return 'destination'


def select_section(source,article,section):
    path = section.get('path') or [section['title']]
    labels = ' / '.join(path[1:])
    if OMIT.search(labels): return False,'references-or-links'
    if source=='wikivoyage': return True,'travel-guide'
    kind = article_kind(article)
    if not labels: return (kind=='attraction','attraction-overview' if kind=='attraction' else 'destination-lead-excluded')
    if NON_TRAVEL.search(labels): return False,'outside-travel-scope'
    if PRACTICAL.search(labels): return True,'practical-planning'
    if kind=='attraction' and ATTRACTION.search(labels): return True,'attraction-understanding'
    return False,'unmatched-conservative-exclusion'


def catalogs(knowledge_root):
    root=Path(knowledge_root)
    voyage=root/'wikivoyage'
    if voyage.exists():
        versions=sorted(path for path in voyage.iterdir() if path.is_dir())
        if versions:
            for language in ('en','zh'):
                path=versions[-1]/language/'catalog.json'
                if path.is_file(): yield 'wikivoyage',language,path
    wikipedia=root/'wikipedia'
    if wikipedia.exists():
        # A partially running landing does not overwrite the completed pilot corpus.
        complete=[]
        for folder in wikipedia.iterdir():
            path=folder/'catalog.json'
            if not path.is_file(): continue
            with path.open(encoding='utf-8') as file: prefix=file.read(1024)
            if re.search(r'"status"\s*:\s*"complete"',prefix): complete.append(path)
        if complete:
            non_pilot=[path for path in complete if 'pilot' not in str(path.parent)]
            yield 'wikipedia',None,sorted(non_pilot or complete)[-1]


def prepare(knowledge_root, *, sample=True, selection=None):
    sections=[];audit=[];sources=[];articles=[]
    allowed=set(selection.get('sources',['wikivoyage'])) if selection else None
    titles=selection.get('article_titles') if selection else None
    found={language:set() for language in titles} if titles else {}
    for source,language,catalog in catalogs(knowledge_root):
        if allowed is not None and source not in allowed:continue
        sources.append({'source':source,'catalog':str(catalog),'language':language})
        for article in iter_articles(catalog):
            title=article.get('title','')
            actual_language=article.get('language') or language or 'zh'
            if selection and selection.get('article_ids') is not None and fingerprint([source,actual_language,title])[:16] not in selection['article_ids']:
                continue
            if titles is not None:
                if title not in titles.get(actual_language,[]):continue
                found[actual_language].add(title)
            elif sample and source=='wikivoyage' and title.lower().replace('_',' ') not in SAMPLE_TITLES: continue
            root=catalog.parent.resolve(); path=(root/article['markdown_path']).resolve()
            if not path.is_relative_to(root): raise ValueError('Catalog path leaves source root')
            raw=path.read_bytes()
            if article.get('sha256') and hashlib.sha256(raw).hexdigest()!=article['sha256']: raise ValueError('Source checksum changed: '+title)
            markdown=raw.decode('utf-8'); actual_language=actual_language or ('zh' if '/zh/' in path.as_posix() else 'en')
            requested_paths=[]
            if selection and selection.get('section_ids') is not None:
                for item in article.get('sections',[]):
                    ident=fingerprint({'source':source,'path':str(path),'revision':article.get('revision_id',article.get('revision')),
                                       'start':item['start_char'],'end':item['end_char']})
                    if ident in selection['section_ids']:requested_paths.append(item['path'])
            article_record={'id':fingerprint([source,actual_language,title])[:16],'title':title,'source':source,
                            'language':actual_language,'chapter_count':len(article.get('sections',[])),'selected_chapter_count':0}
            articles.append(article_record)
            for section in article.get('sections',[]):
                selected,reason=select_section(source,article,section)
                identity=fingerprint({'source':source,'path':str(path),'revision':article.get('revision_id',article.get('revision')),
                                      'start':section['start_char'],'end':section['end_char']})
                text=markdown[section['start_char']:section['end_char']]
                if not text.strip(): selected=False;reason='empty'
                if selection and selection.get('section_ids') is not None:
                    selected=any(section['path'][:len(p)]==p for p in requested_paths) and bool(text.strip());reason='explicit-range'
                record={'id':identity,'source':source,'language':actual_language,'article_title':title,'article_kind':article_kind(article),
                        'path':section['path'],'selected':selected,'reason':reason,'rule_version':RULE_VERSION,
                        'source_file':str(path),'source_url':article.get('source_url',article.get('url')),
                        'license':article.get('license','CC-BY-SA-4.0'),
                        'license_url':article.get('license_url','https://creativecommons.org/licenses/by-sa/4.0/'),
                        'revision_url':article.get('revision_url'),'history_url':article.get('history_url'),
                        'revision':article.get('revision_id',article.get('revision')),'start_char':section['start_char'],
                        'end_char':section['end_char'],'text':text,'sha256':hashlib.sha256(raw).hexdigest()}
                audit.append(record)
                if selected:sections.append(record);article_record['selected_chapter_count']+=1
    if titles and any(set(titles[l])-found[l] for l in titles):raise ValueError('Dataset contains articles missing from landed catalogs')
    return {'id':fingerprint({'rules':RULE_VERSION,'sections':[(s['id'],fingerprint(s['text']),s['selected']) for s in audit]})[:24],
            'scope':selection.get('scope','regional-sample') if selection else 'representative-sample' if sample else 'all-landed',
            'label':selection.get('name') if selection else None,'rules':RULE_VERSION,'sources':sources,
            'articles':articles,'article_count':len(articles),'articles_by_language':dict(Counter(a['language'] for a in articles)),
            'sections':sections,'audit':audit}


def selected_corpus(corpus, rule='practical-attractions'):
    records=[]
    for original in corpus.get('audit',corpus['sections']):
        record=dict(original)
        if rule=='all' and record.get('reason') != 'explicit-range':
            record.update(selected=bool(record['text'].strip()),reason='selected-article-body')
        if rule=='practical' and record['source']=='wikipedia' and record.get('reason') in ('attraction-understanding','attraction-overview'):
            record.update(selected=False,reason='attraction-detail-disabled')
        records.append(record)
    return {**corpus,'sections':[r for r in records if r.get('selected',True)],'audit':records}


def content_range(section):
    text=section['text'];match=re.match(r'^#{1,6}\s+[^\n]*\n?',text)
    start=match.end() if match else 0
    start+=len(text[start:])-len(text[start:].lstrip())
    return start,len(text.rstrip())


def units(section, maximum=500):
    """Contiguous sentence/paragraph units with offsets into the unchanged section."""
    start,end=content_range(section);text=section['text'];result=[]
    for match in re.finditer(r'.+?(?:[。！？.!?](?:\s|$)|\n\s*\n|$)',text[start:end],re.S):
        a=start+match.start();b=start+match.end()
        while a<b:
            result.append((a,min(a+maximum,b)));a+=maximum
    return result


def recursive_spans(section, size, overlap, merge_small=False):
    """Split only oversized structures, keeping source offsets and whole-unit overlap."""
    origin,end=content_range(section);text=section['text'];leaves=[];steps=[]
    separators=[('listing',r'\n(?=[*+-] |\d+\. )'),('paragraph',r'\n\s*\n'),('line',r'\n'),
                ('sentence',r'[。！？．]+[”’」』）"]*|[.!?]+["\x27”’)]*(?=\s|$)'),
                ('word',r'[ \t]+')]
    def descend(a,b,level,path):
        if b-a<=size:
            leaves.append({'start':a,'end':b,'path':path or ['section']});return
        for index in range(level,len(separators)):
            name,pattern=separators[index]
            cuts=[a+m.end() for m in re.finditer(pattern,text[a:b]) if a+m.end()<b]
            points=[a,*cuts,b]
            parts=list(zip(points,points[1:]))
            steps.append({'level':name,'start':a,'end':b,'input_chars':b-a,'parts':len(parts),
                          'oversized_parts':sum(right-left>size for left,right in parts)})
            if cuts:
                for left,right in parts:descend(left,right,index+1,[*path,name])
                return
        parts=[(left,min(left+size,b)) for left in range(a,b,size)]
        steps.append({'level':'character','start':a,'end':b,'input_chars':b-a,'parts':len(parts),'oversized_parts':0})
        leaves.extend({'start':left,'end':right,'path':[*path,'character']} for left,right in parts)
    descend(origin,end,0,[])
    groups=[];cursor=0
    while cursor<len(leaves):
        stop=cursor+1
        if merge_small:
            while stop<len(leaves) and leaves[stop]['end']-leaves[cursor]['start']<=size:stop+=1
        a,b=leaves[cursor]['start'],leaves[stop-1]['end']
        # Overlap may be shorter than requested: never cut a structural unit just to fill it.
        if not merge_small and cursor:
            earliest=max(origin,a-min(overlap,size-(b-a)))
            starts=[leaf['start'] for leaf in leaves[:cursor] if earliest<=leaf['start']<a]
            if starts:a=min(starts)
        groups.append({'start':a,'end':b,'boundary':leaves[stop-1]['path'][-1],
                       'structure_units':stop-cursor})
        if stop==len(leaves):break
        next_cursor=stop
        if merge_small:
            while next_cursor-1>cursor and b-leaves[next_cursor-1]['start']<=overlap and leaves[stop]['end']-leaves[next_cursor-1]['start']<=size:
                next_cursor-=1
        cursor=next_cursor
    return groups,{'version':RECURSIVE_VERSION,'merge_small':merge_small,'maximum_chars':size,
                   'overlap_chars':overlap,'structure_units':len(leaves),'generated_chunks':len(groups),'steps':steps}


def chunk_report(corpus,size=1200,overlap=120,strategy='recursive',semantic_spans=None,*,recursive_merge_small=False):
    result=[]; counts={};recursive={};chunk_details={}
    # Breadth first: one passage per section before additional passages of long sections.
    candidates=[]
    for section in corpus['sections']:
        origin,end=content_range(section);content=section['text'][origin:end]
        if strategy=='semantic':
            if semantic_spans is None:raise ValueError('SEMANTIC_CHUNKS_REQUIRE_EXPLICIT_RUN')
            spans=semantic_spans[section['id']]
        elif strategy=='recursive':
            groups,recursive[section['id']]=recursive_spans(section,size,overlap,recursive_merge_small)
            spans=[(g['start'],g['end']) for g in groups]
            chunk_details.update({(section['id'],g['start'],g['end']):
                                  {'end_boundary':g['boundary'],'structure_units':g['structure_units']} for g in groups})
        else:
            patterns=[r'\n\s*\n'] if strategy=='paragraph' else []
            boundaries=[[m.end()+origin for m in re.finditer(pattern,content)] for pattern in patterns]
            spans=[];start=origin
            while start<end:
                stop=min(start+size,end)
                if strategy!='fixed' and stop<end:
                    for group in boundaries:
                        possible=[b for b in group if start+max(40,size//3)<=b<=stop]
                        if possible:stop=max(possible);break
                spans.append((start,stop))
                if stop==end and strategy!='fixed':break
                start=start+size-overlap if strategy=='fixed' else max(start+1,stop-overlap)
        for order,(a,b) in enumerate(spans):
            start=a-origin;text=section['text'][a:b]
            if not text.strip(): continue
            candidates.append((order,section,start,text,a,b))
    for order,section,start,text,a,b in candidates:
        article=(section['source'],section['language'],section['article_title'])
        result.append({**{k:v for k,v in section.items() if k not in ('text','selected')},'section_id':section['id'],
                       'id':fingerprint([section['id'],start,size,overlap] if strategy=='fixed' else
                                        [section['id'],a,b,strategy,RECURSIVE_VERSION] if strategy=='recursive' else [section['id'],a,b,strategy]),
                       'offset':start,'section_start':a,'section_end':b,'chunk_strategy':strategy,'text':text,
                       **chunk_details.get((section['id'],a,b),{}),
                       'embedding_text':section['article_title']+' · '+' / '.join(section['path'][1:])+'\n'+text})
    return {'chunks':result,'generated_count':len(candidates),'retained_count':len(result),
            'retained_chars':sum(len(p['embedding_text']) for p in result),'strategy':strategy,
            'section_count':len(corpus['sections']),'generated_by_section':dict(Counter(c[1]['id'] for c in candidates)),
            'recursive_by_section':recursive}


def chunks(corpus,size=1200,overlap=120):
    return chunk_report(corpus,size,overlap)['chunks']
