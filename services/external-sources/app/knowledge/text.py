from collections import Counter
import re

def tokenize(text):
    """Replaceable Chinese adapter: Han unigrams + bigrams, Latin word tokens."""
    result = []
    for part in re.findall('[\\u3400-\\u9fff]+|[a-zA-Z0-9]+', text.lower()):
        if '㐀' <= part[0] <= '鿿':
            result.extend(part)
            result.extend((part[i:i + 2] for i in range(len(part) - 1)))
        else:
            result.append(part)
    return result

def sparse(tokens, vocabulary, average=None):
    counts = Counter(tokens)
    pairs = []
    for term, count in counts.items():
        if term not in vocabulary:
            continue
        weight = count * 2.2 / (count + 1.2 * (0.25 + 0.75 * len(tokens) / average)) if average else 1.0
        pairs.append((vocabulary[term], weight))
    pairs.sort()
    return {'indices': [p[0] for p in pairs], 'values': [p[1] for p in pairs]}
