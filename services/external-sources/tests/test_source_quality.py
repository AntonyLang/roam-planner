import json
from pathlib import Path
import sys
import threading

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import source_review as review
import source_quality as quality


def setup(db):
    review.initialize(db)
    with review.connect(db) as c:
        for note_id in ('a', 'b'):
            record = {'record_id': 'xhs_'+note_id, 'source': {}, 'normalized': {'title': '真实样式旅行资料',
                      'text': '栈桥上午步行，小青岛下午休息。'}, 'ocr': []}
            c.execute('INSERT INTO notes VALUES(?,?,?)', (note_id,json.dumps(record), '[]'))
            for index in (1, 2):
                ocr={'text':['路线可执行' if index==1 else '纯广告'], 'n_lines':1, 'avg_score':.95}
                c.execute('INSERT INTO images VALUES(?,?,?,?,?,?)', (note_id+str(index),note_id,'fixture.png',str(index)+'.png',index,json.dumps(ocr)))


def mock_config(monkeypatch):
    monkeypatch.setattr(quality, 'settings', lambda: {'key':'fixture-key','url':'https://fixture.invalid','model':'bocha-jev-v1','threshold':.8})


def provider(monkeypatch, handler):
    original=httpx.Client
    transport=httpx.MockTransport(handler)
    monkeypatch.setattr(quality.httpx, 'Client', lambda **kwargs: original(transport=transport,**kwargs))


def answer(request, choice):
    data=json.loads(request.content)
    candidates=data['questions']['quality']['criteria']
    probabilities={k:.94 if k==choice else .06/(len(candidates)-1) for k in candidates}
    return httpx.Response(200,json={'model':'bocha-jev-v1','answers':{'quality':{'type':'choice','choice':choice,'confidence':.94,'probabilities':probabilities}},'usage':{'input_tokens':123,'output_tokens':0}})


def test_auto_applies_each_image_and_preserves_manual_choices(tmp_path,monkeypatch):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    review.save_review(db,'b',{'decision':'keep_body','reason':'人工已选','revision':0,'request_id':'human'})
    calls=[]
    def handle(request):
        payload=json.loads(request.content);calls.append(payload)
        image=payload['state'].get('image')
        return answer(request,'keep' if not image or image['file']=='1.png' else 'discard')
    provider(monkeypatch,handle)
    manager=quality.Manager(db)
    manager.start({'request_id':'job1','max_posts':2,'token_budget':100000})
    manager.thread.join(10)
    assert not manager.thread.is_alive()
    assert len(calls)==3 and all(len(c['questions'])==1 for c in calls)
    assert all('images' not in c['state'] for c in calls if 'image' in c['state'])
    assert review.detail(db,'a')['selected_images']==['a1']
    assert review.detail(db,'b')['source']=='manual'
    exported=list(review.selected_records(db))
    a=next(r for r in exported if r['record_id']=='xhs_a')
    assert [i['file'] for i in a['ocr']]==['1.png']
    assert a['review']['content_scope']=='body_and_selected_ocr'
    assert manager.status()['run']['input_tokens']==369
    assert manager.status()['run']['state']=='completed'
    manager.close()


def test_stop_waits_for_current_call_and_resume_reuses_image_cache(tmp_path,monkeypatch):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    entered,release=threading.Event(),threading.Event();calls=[]
    def handle(request):
        calls.append(json.loads(request.content))
        if len(calls)==1:
            entered.set();assert release.wait(5)
        return answer(request,'keep')
    provider(monkeypatch,handle)
    manager=quality.Manager(db)
    manager.start({'request_id':'first','max_posts':1,'token_budget':100000})
    assert entered.wait(5)
    manager.stop()
    assert manager.status()['run']['state']=='stopping'
    release.set();manager.thread.join(5)
    assert len(calls)==1 and manager.status()['run']['state']=='stopped'
    assert 'body:a' in quality.results(db,'a')
    manager.start({'request_id':'resume','max_posts':1,'token_budget':100000})
    manager.thread.join(5)
    assert len(calls)==3  # body a was not sent to the provider a second time.
    assert manager.status()['run']['input_tokens']==246
    manager.close()


def test_human_change_during_call_is_preserved(tmp_path,monkeypatch):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    manager=quality.Manager(db)
    entered,release=threading.Event(),threading.Event()
    def handle(request):
        entered.set();assert release.wait(5)
        return answer(request,'keep')
    provider(monkeypatch,handle)
    manager.start({'request_id':'human-race','max_posts':1,'token_budget':100000})
    assert entered.wait(5)
    review.save_review(db,'a',{'decision':'discard','reason':'人手排除','revision':0,'request_id':'human-race-selection'})
    review.save_review(db,'b',{'decision':'manual','reason':'人手待核对','revision':0,'request_id':'human-b'})
    release.set();manager.thread.join(5)
    assert review.detail(db,'a')['decision']=='discard' and review.detail(db,'a')['source']=='manual'
    assert manager.status()['run']['state']=='completed'
    manager.close()


def test_missing_usage_stops_without_zero_accounting(tmp_path,monkeypatch):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    calls=[]
    def handle(request):
        calls.append(request)
        r=answer(request,'keep');data=r.json();data.pop('usage')
        return httpx.Response(200,json=data)
    provider(monkeypatch,handle)
    manager=quality.Manager(db)
    manager.start({'request_id':'missing','max_posts':1,'token_budget':100000})
    manager.thread.join(5)
    assert len(calls)==1 and manager.status()['run']['state']=='failed'
    assert manager.status()['calls']['unknown']==1
    assert quality.results(db,'a')['body:a']['action']=='failed'
    assert review.detail(db,'a')['decision']=='pending'
    manager.start({'request_id':'no-unknown-replay','max_posts':1,'token_budget':100000})
    manager.thread.join(5)
    assert len(calls)==1 and manager.status()['run']['state']=='failed'
    manager.close()


def test_body_and_images_independent_with_program_aggregate(tmp_path,monkeypatch):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    calls=[]
    def handle(request):
        state=json.loads(request.content)['state'];calls.append(state)
        return answer(request,'discard' if state['component']=='body' or state['image']['file']=='2.png' else 'keep')
    provider(monkeypatch,handle)
    manager=quality.Manager(db)
    manager.start({'request_id':'ocr-only','max_posts':1,'token_budget':100000})
    manager.thread.join(5)
    assert len(calls)==3 and [s['component'] for s in calls]==['body','image_ocr','image_ocr']
    assert all('body_excerpt' not in s and 'body' not in s for s in calls)
    post=review.detail(db,'a')
    assert post['include_body'] is False and post['selected_images']==['a1']
    record=list(review.selected_records(db))[0]
    assert record['normalized']['text']==''
    assert record['normalized']['text_sources']==['ocr']
    assert record['review']['content_scope']=='selected_ocr_only'
    assert quality.results(db,'a')['post:a']['source']=='program_aggregate'
    assert manager.status()['counts']=={'keep':1}
    manager.close()


def test_uncertain_component_is_discarded_and_valid_components_auto_apply(tmp_path,monkeypatch):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    def handle(request):
        data=answer(request,'keep').json()
        if json.loads(request.content)['state']['component']=='body':
            data['answers']['quality'].update(confidence=.55,probabilities={'keep':.55,'discard':.45})
        return httpx.Response(200,json=data)
    provider(monkeypatch,handle)
    manager=quality.Manager(db)
    manager.start({'request_id':'uncertain','max_posts':1,'token_budget':100000})
    manager.thread.join(5)
    post=review.detail(db,'a')
    assert post['decision']=='keep' and post['selected_images']==['a1','a2']
    assert post['include_body'] is False
    exported=list(review.selected_records(db))
    assert len(exported)==1 and exported[0]['review']['content_scope']=='ocr_only'
    assert quality.results(db,'a')['body:a']['action']=='discard'
    assert all(result['action']!='manual' for result in quality.results(db,'a').values())
    assert manager.status()['requires_manual_review'] is False
    manager.close()


def test_unlimited_usage_exceeds_old_budget_and_still_stops_safely(tmp_path,monkeypatch):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    entered,release=threading.Event(),threading.Event();calls=[]
    def handle(request):
        calls.append(request)
        if len(calls)==3:
            entered.set();assert release.wait(5)
        value=answer(request,'keep').json()
        value['usage']={'input_tokens':200_000_000,'output_tokens':100}
        return httpx.Response(200,json=value)
    provider(monkeypatch,handle)
    manager=quality.Manager(db)
    started=manager.start({'request_id':'unlimited','max_posts':1,'token_budget':1000})
    assert entered.wait(5)
    assert manager.status()['run']['input_tokens']==400_000_000
    assert manager.status()['run']['token_budget']==0
    assert manager.start({'request_id':'unlimited','max_posts':1})['idempotent'] is True
    manager.stop();release.set();manager.thread.join(5)
    assert not manager.thread.is_alive() and manager.status()['run']['state']=='stopped'
    assert manager.status()['run']['input_tokens']==600_000_000
    assert manager.status()['run']['output_tokens']==300
    manager.start({'request_id':'resume-unlimited','max_posts':1})
    manager.thread.join(5)
    assert len(calls)==3 and manager.status()['run']['state']=='completed'
    assert review.detail(db,'a')['decision']=='keep'
    manager.close()


def test_changed_policy_preserves_old_auto_and_manual_results(tmp_path,monkeypatch):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    review.save_review(db,'a',{'decision':'keep_body','reason':'旧自动结果','revision':0,'request_id':'old-auto'},source='jev')
    review.save_review(db,'b',{'decision':'keep_body','reason':'人工结果','revision':0,'request_id':'human'})
    quality.initialize(db)
    with review.connect(db) as c:
        old={'action':'keep_body','applied':True,'policy':'previous-policy'}
        c.execute('INSERT INTO quality_assessments VALUES(?,?,?,?,?,?)',('post:a','a',None,'old-hash',json.dumps(old),review.now()))
    calls=[]
    def handle(request):
        calls.append(request)
        return answer(request,'discard')
    provider(monkeypatch,handle)
    manager=quality.Manager(db)
    assert manager.status()['pending_posts']==0
    assert manager.status()['rechecks_existing'] is False
    manager.start({'request_id':'new-policy','max_posts':2,'token_budget':100000})
    manager.thread.join(5)
    assert len(calls)==0 and review.detail(db,'a')['decision']=='keep_body'
    assert review.detail(db,'b')['decision']=='keep_body' and review.detail(db,'b')['source']=='manual'
    assert review.detail(db,'a')['revision']==1
    assert quality.results(db,'a')['post:a']['policy']=='previous-policy'
    manager.start({'request_id':'same-policy','max_posts':2,'token_budget':100000})
    manager.thread.join(5)
    assert len(calls)==0  # Completed old-policy results do not incur another call.
    manager.close()


@pytest.mark.parametrize('decision',['keep_body','discard','manual'])
def test_old_review_without_aggregate_is_skipped_and_only_unreviewed_is_processed(tmp_path,monkeypatch,decision):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    review.save_review(db,'a',{'decision':decision,'reason':'旧结果','revision':0,'request_id':'old'},source='jev')
    original=review.detail(db,'a')
    provider(monkeypatch,lambda request:answer(request,'keep'))
    manager=quality.Manager(db)
    assert manager.status()['pending_posts']==1
    manager.start({'request_id':'unreviewed-only','max_posts':2})
    manager.thread.join(5)
    assert review.detail(db,'a')==original
    assert review.detail(db,'b')['decision']=='keep'
    with review.connect(db) as c:
        assert {row['note_id'] for row in c.execute('SELECT note_id FROM quality_calls')}=={'b'}
    assert manager.status()['pending_posts']==0
    manager.close()


@pytest.mark.parametrize('changed_text',[False,True])
def test_restart_and_new_policy_resume_partial_post_without_rebilling_unchanged_units(tmp_path,monkeypatch,changed_text):
    db=tmp_path/'review.sqlite';setup(db);mock_config(monkeypatch)
    entered,release=threading.Event(),threading.Event();calls=[]
    def handle(request):
        calls.append(json.loads(request.content))
        if len(calls)==2:
            entered.set();assert release.wait(5)
        return answer(request,'keep')
    provider(monkeypatch,handle)
    manager=quality.Manager(db)
    manager.start({'request_id':'partial','max_posts':1})
    assert entered.wait(5)
    manager.stop();release.set();manager.thread.join(5)
    assert len(calls)==2 and review.detail(db,'a')['decision']=='pending'
    old_policy=quality.POLICY
    with review.connect(db) as c:
        for row in c.execute('SELECT target,result FROM quality_assessments').fetchall():
            result=json.loads(row['result']);result.pop('content_hash',None)
            c.execute('UPDATE quality_assessments SET result=? WHERE target=?',(json.dumps(result),row['target']))
        if changed_text:
            record=json.loads(c.execute("SELECT record FROM notes WHERE id='a'").fetchone()['record'])
            record['normalized']['text']='正文内容已经发生修改，需要新的审核。'
            c.execute("UPDATE notes SET record=? WHERE id='a'",(json.dumps(record),))
    manager.close()
    monkeypatch.setattr(quality,'POLICY','next-policy')
    resumed=quality.Manager(db)
    resumed.start({'request_id':'after-restart','max_posts':1})
    resumed.thread.join(5)
    assert resumed.status()['run']['state']=='completed'
    assert len(calls)==(4 if changed_text else 3)
    assert resumed.status()['run']['input_tokens']==(246 if changed_text else 123)
    assert quality.results(db,'a')['image:a1']['policy']==old_policy
    assert quality.results(db,'a')['body:a']['policy']==('next-policy' if changed_text else old_policy)
    assert review.detail(db,'a')['decision']=='keep'
    resumed.close()
