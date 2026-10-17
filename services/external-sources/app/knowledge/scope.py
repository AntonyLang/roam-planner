from .archive import article_uri


def allowed_passage_ids(passages, document_ids=None, destination=None):
    """Return passage IDs within the requested document and destination scope.

    A ``None`` document scope is unrestricted; an empty list matches nothing.
    Versioned ``guide://`` identifiers match only their exact article revision.
    Legacy source URLs, or titles when a URL is absent, remain exact matches.
    """
    requested_documents = None if document_ids is None else set(document_ids)
    requested_guide_uris = (
        set() if requested_documents is None else
        {identifier for identifier in requested_documents if identifier.startswith('guide://')}
    )
    requested_legacy_ids = (
        set() if requested_documents is None else requested_documents - requested_guide_uris
    )
    allowed = set()

    for passage in passages:
        title = passage['article_title']
        if requested_documents is not None:
            versioned_uri = article_uri(
                passage['source'],
                passage['language'],
                title,
                passage['sha256'],
            )
            legacy_id = passage['source_url'] or title
            if versioned_uri not in requested_guide_uris and legacy_id not in requested_legacy_ids:
                continue

        if destination and destination.casefold() not in title.casefold():
            continue

        allowed.add(passage['id'])

    return allowed
