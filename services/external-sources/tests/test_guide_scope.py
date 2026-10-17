from app.knowledge.archive import article_uri
from app.knowledge.scope import allowed_passage_ids


def passage(identifier, *, title, source_url, version, source='wiki', language='zh'):
    return {
        'id': identifier,
        'source': source,
        'language': language,
        'article_title': title,
        'sha256': version,
        'source_url': source_url,
    }


def test_search_guide_uri_can_scope_all_passages_from_that_revision():
    first = passage(
        'qingdao-1',
        title='Qingdao / 青岛',
        source_url='https://example.test/qingdao',
        version='revision-a',
    )
    second = {**first, 'id': 'qingdao-2'}
    other_article = passage(
        'jinan-1',
        title='Jinan',
        source_url='https://example.test/jinan',
        version='revision-a',
    )
    returned_search_uri = article_uri(
        first['source'], first['language'], first['article_title'], first['sha256']
    )

    assert allowed_passage_ids([first, second, other_article], [returned_search_uri]) == {
        'qingdao-1',
        'qingdao-2',
    }


def test_old_guide_uri_does_not_fall_back_to_current_title_or_url():
    current = passage(
        'qingdao-current',
        title='Qingdao',
        source_url='https://example.test/qingdao',
        version='revision-new',
    )
    unrelated = passage(
        'jinan-current',
        title='Jinan',
        source_url='https://example.test/jinan',
        version='revision-new',
    )
    old_revision_uri = article_uri(
        current['source'], current['language'], current['article_title'], 'revision-old'
    )

    assert allowed_passage_ids([current, unrelated], [old_revision_uri]) == set()


def test_legacy_source_url_and_title_remain_supported():
    qingdao = passage(
        'qingdao',
        title='Qingdao',
        source_url='https://example.test/qingdao',
        version='revision-a',
    )
    jinan = passage(
        'jinan',
        title='Jinan',
        source_url=None,
        version='revision-a',
    )

    assert allowed_passage_ids([qingdao, jinan], ['https://example.test/qingdao']) == {'qingdao'}
    assert allowed_passage_ids([qingdao, jinan], ['Jinan']) == {'jinan'}


def test_destination_and_document_scope_are_intersected():
    qingdao = passage(
        'qingdao',
        title='Qingdao Old Town',
        source_url='https://example.test/travel',
        version='revision-a',
    )
    jinan = passage(
        'jinan',
        title='Jinan Old Town',
        source_url='https://example.test/travel',
        version='revision-a',
    )
    other_qingdao = passage(
        'qingdao-other',
        title='Qingdao Museum',
        source_url='https://example.test/other',
        version='revision-a',
    )

    assert allowed_passage_ids(
        [qingdao, jinan, other_qingdao],
        ['https://example.test/travel'],
        destination='QINGDAO',
    ) == {'qingdao'}


def test_none_is_unrestricted_and_empty_document_scope_matches_nothing():
    passages = [
        passage(
            'qingdao',
            title='Qingdao',
            source_url='https://example.test/qingdao',
            version='revision-a',
        ),
        passage(
            'jinan',
            title='Jinan',
            source_url='https://example.test/jinan',
            version='revision-a',
        ),
    ]

    assert allowed_passage_ids(passages) == {'qingdao', 'jinan'}
    assert allowed_passage_ids(passages, []) == set()
